import { VIDEO_HEADER_BYTES, videoHeader } from "@kitties/protocol/video";

export type DesktopViewMode = "video" | "jpeg";
interface Options {
  base: string;
  canvas: HTMLCanvasElement;
  generation: number;
  epoch: number;
  onFrame: (mode: DesktopViewMode) => void;
  onDisconnect: () => void;
}

function codecFromKeyframe(data: Uint8Array) {
  // SPS NAL in Annex-B: profile_idc, constraint flags, level_idc.
  for (let index = 0; index + 6 < data.length; index++) {
    if (
      data[index] === 0 &&
      data[index + 1] === 0 &&
      data[index + 2] === 1 &&
      (data[index + 3] & 31) === 7
    )
      return (
        "avc1." +
        Array.from(data.subarray(index + 4, index + 7), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")
      );
  }
  return undefined;
}

/** Media has no input capability. A dropped/failed picture never replays input,
 * acquires a grant, or mutates the control socket's queue. */
export function createDesktopViewer(options: Options) {
  let socket: WebSocket | undefined;
  let decoder: VideoDecoder | undefined;
  let stopped = false,
    waitingKey = true,
    ready = false;
  let mode: DesktopViewMode =
    typeof VideoDecoder === "function" && typeof EncodedVideoChunk === "function"
      ? "video"
      : "jpeg";
  let firstFrame: ReturnType<typeof setTimeout> | undefined;
  let lastKey = 0;
  const pending = new Map<number, number>();
  const context = options.canvas.getContext("2d", { alpha: false });
  if (!context) throw Error("Canvas unavailable");
  function resetDecoder() {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = undefined;
    pending.clear();
    waitingKey = true;
  }
  function send(body: unknown) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
  }
  function requestKeyframe() {
    if (Date.now() - lastKey < 500) return;
    lastKey = Date.now();
    send({ type: "keyframe" });
  }
  function paint(picture: CanvasImageSource, width: number, height: number) {
    if (options.canvas.width !== width) options.canvas.width = width;
    if (options.canvas.height !== height) options.canvas.height = height;
    context!.drawImage(picture, 0, 0);
    clearTimeout(firstFrame);
    options.onFrame(mode);
  }
  function disconnect() {
    close();
    options.onDisconnect();
  }
  function fallback() {
    if (stopped || mode === "jpeg") return;
    mode = "jpeg";
    clearTimeout(firstFrame);
    const old = socket;
    socket = undefined;
    old?.close();
    resetDecoder();
    connect();
  }
  function video(bytes: Uint8Array, peer: WebSocket) {
    const header = videoHeader(bytes);
    if (!header || !ready) {
      fallback();
      return;
    }
    if (header.generation !== options.generation) {
      disconnect();
      return;
    }
    if (waitingKey && !header.key) {
      requestKeyframe();
      return;
    }
    const data = bytes.subarray(VIDEO_HEADER_BYTES);
    if (!decoder) {
      const codec = codecFromKeyframe(data);
      if (!codec) {
        fallback();
        return;
      }
      const next = new VideoDecoder({
        output(frame) {
          try {
            if (stopped || socket !== peer || decoder !== next) return;
            const seq = pending.get(frame.timestamp);
            if (seq === undefined) return;
            pending.delete(frame.timestamp);
            paint(frame, frame.displayWidth, frame.displayHeight);
            send({ type: "video_ack", seq });
          } finally {
            frame.close();
          }
        },
        error() {
          if (decoder === next) fallback();
        },
      });
      decoder = next;
      next.configure({ codec, optimizeForLatency: true });
      waitingKey = false;
    }
    // Bound work on the browser as well as on the relay. Reconfigure on the
    // next keyframe after dropping anything; a delta cannot repair a decode chain.
    if (decoder.decodeQueueSize >= 6 || pending.size >= 8) {
      resetDecoder();
      requestKeyframe();
      return;
    }
    const timestamp = header.seq * 1000;
    pending.set(timestamp, header.seq);
    decoder.decode(new EncodedVideoChunk({ type: header.key ? "key" : "delta", timestamp, data }));
  }
  async function jpeg(bytes: ArrayBuffer, peer: WebSocket) {
    if (bytes.byteLength <= 8 || bytes.byteLength > 1024 * 1024 + 8) {
      disconnect();
      return;
    }
    const view = new DataView(bytes);
    if (view.getUint32(0) !== options.generation) {
      disconnect();
      return;
    }
    const seq = view.getUint32(4);
    const picture = await createImageBitmap(new Blob([bytes.slice(8)], { type: "image/jpeg" }));
    try {
      if (stopped || socket !== peer) return;
      paint(picture, picture.width, picture.height);
      send({ type: "frame_ack", seq });
    } finally {
      picture.close();
    }
  }
  function connect() {
    if (stopped) return;
    const peer = new WebSocket(`${options.base}/${mode === "video" ? "video" : "frames"}`);
    socket = peer;
    peer.binaryType = "arraybuffer";
    ready = false;
    firstFrame = setTimeout(() => {
      if (socket !== peer || stopped) return;
      if (mode === "video") fallback();
      else disconnect();
    }, 5000);
    peer.onclose = (event) => {
      if (stopped || socket !== peer) return;
      if (event.code === 4001) {
        disconnect();
        return;
      }
      if (mode === "video") fallback();
      else disconnect();
    };
    peer.onerror = () => peer.close();
    peer.onmessage = (event) => {
      if (stopped || socket !== peer) return;
      try {
        if (typeof event.data === "string") {
          if (event.data === "pong") return;
          const body = JSON.parse(event.data);
          if (body.type === "video_ready") {
            if (body.generation !== options.generation || body.epoch !== options.epoch) {
              disconnect();
              return;
            }
            ready = true;
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        if (mode === "video") video(new Uint8Array(event.data), peer);
        else
          void jpeg(event.data, peer).catch(() => {
            if (socket === peer) disconnect();
          });
      } catch {
        fallback();
      }
    };
  }
  const heartbeat = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send("ping");
    if (mode === "video" && waitingKey && ready) requestKeyframe();
  }, 1000);
  function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(firstFrame);
    const old = socket;
    socket = undefined;
    old?.close();
    resetDecoder();
  }
  connect();
  return { close };
}
