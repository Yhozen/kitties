import { videoHeader } from "@kitties/protocol/video";

/** Starts only with viewer demand. voxl is loopback-only, password protected and
 * read-only. The relay never forwards browser text or binary commands to it. */
export function startVideo(options: {
  url: string;
  headers: Record<string, string>;
  generation: number;
  env: Record<string, string | undefined>;
  ended: () => void;
}) {
  const password = crypto.randomUUID() + crypto.randomUUID();

  const child = Bun.spawn(
    [
      "/usr/local/lib/kittyd/voxl",
      "--addr=127.0.0.1",
      "--port=19223",
      "--read-only=true",
      "--audio-enabled=false",
      "--microphone-enabled=false",
      "--enable-clipboard=false",
      "--file-transfers=none",
      "--enable-resize=false",
      "--stripes=1",
      "--framerate=60",
      "--max-kbps=6000",
      "--min-kbps=500",
      "--crf=24",
      "--encoder-threads=2",
      "--convert-threads=2",
    ],
    {
      env: { ...options.env, VOXL_PASSWORD: password },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  let local: WebSocket | undefined,
    remote: WebSocket | undefined,
    stopped = false;

  let retry: ReturnType<typeof setTimeout> | undefined;
  let keyTimer: ReturnType<typeof setTimeout> | undefined;

  let waitingKey = true,
    lastKey = 0;

  const started = Date.now();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    clearTimeout(keyTimer);
    clearInterval(heartbeat);
    local?.close();
    remote?.close();
    child.kill("SIGKILL");
    options.ended();
  }

  function keyframe() {
    if (stopped || local?.readyState !== WebSocket.OPEN) return;
    const remaining = 500 - (Date.now() - lastKey);

    if (remaining > 0) {
      keyTimer ??= setTimeout(() => {
        keyTimer = undefined;
        keyframe();
      }, remaining);

      return;
    }

    clearTimeout(keyTimer);
    keyTimer = undefined;
    lastKey = Date.now();
    local.send("kf");
  }

  function connect() {
    if (stopped) return;

    const socket = new WebSocket("ws://127.0.0.1:19223/ws", {
      headers: { Authorization: `Bearer ${password}` },
    });

    local = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send("v,0");
    socket.onmessage = (event) => {
      if (stopped) return;

      try {
        if (typeof event.data === "string") {
          const body = JSON.parse(event.data);

          if (body.t === "ping" && typeof body.s === "number") socket.send(`po,${body.s}`);

          if (body.t === "hello") {
            if (remote || body.readOnly !== true || body.audio || body.stripes?.length !== 1)
              return stop();
            const upstream = new WebSocket(options.url, { headers: options.headers });
            remote = upstream;
            upstream.onopen = () => {
              socket.send("v,1");
            };

            upstream.onmessage = (message) => {
              if (message.data === "pong") return;

              // No generic command proxy: only a validated keyframe request is allowed.
              try {
                if (JSON.parse(String(message.data)).type === "keyframe") keyframe();
              } catch {
                stop();
              }
            };

            upstream.onclose = stop;
            upstream.onerror = stop;
          }

          return;
        }

        const bytes = new Uint8Array(event.data as ArrayBuffer);

        if (bytes[0] !== 1) return; // Discard cursor, audio and clipboard channels.
        const packet = new Uint8Array(bytes.length + 4);
        new DataView(packet.buffer).setUint32(0, options.generation);
        packet.set(bytes, 4);
        const frame = videoHeader(packet);

        if (!frame) return stop();
        socket.send(`a,${frame.seq}`);

        if (remote?.readyState !== WebSocket.OPEN || remote.bufferedAmount > 512 * 1024) {
          waitingKey = true;

          return;
        }

        if (waitingKey && !frame.key) {
          keyframe();

          return;
        }

        waitingKey = false;
        remote.send(packet);
      } catch {
        stop();
      }
    };

    socket.onclose = () => {
      if (stopped) return;

      if (remote || Date.now() - started > 5000) stop();
      else retry = setTimeout(connect, 200);
    };

    socket.onerror = () => socket.close();
  }

  const heartbeat = setInterval(() => {
    if (remote?.readyState === WebSocket.OPEN) remote.send("ping");

    if (waitingKey) keyframe();
  }, 1000);

  void child.exited.then(stop);
  connect();

  return stop;
}
