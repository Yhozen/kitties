import { t } from "./i18n";
import { useEffect, useRef, useState } from "preact/hooks";
const namedKeys: Record<string,string> = {Enter:"Return",Backspace:"BackSpace",Tab:"Tab",Escape:"Escape",Delete:"Delete",ArrowUp:"Up",ArrowDown:"Down",ArrowLeft:"Left",ArrowRight:"Right",Home:"Home",End:"End",PageUp:"Prior",PageDown:"Next"};
const xKeys=(event:KeyboardEvent) => {
  const named=namedKeys[event.key] ?? (/^F\d{1,2}$/.test(event.key)?event.key:"");
  if(!named && !event.ctrlKey && !event.altKey && !event.metaKey)return "";
  if(["Control","Alt","Shift","Meta"].includes(event.key))return "";
  return [event.ctrlKey&&"ctrl",event.altKey&&"alt",event.metaKey&&"super",event.shiftKey&&named&&"shift",named || (event.key===" "?"space":event.key.toLowerCase())].filter(Boolean).join("+");
};

interface Receipt { nonce: string; generation: number; epoch: number }

export default function WSDesktop({ id, onClose }: { id: string; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | undefined>(undefined);
  const grant = useRef<Receipt | undefined>(undefined);
  const alive = useRef(true);
  const [status, setStatus] = useState(t("Connecting…"));
  const [controlling, setControlling] = useState(false);
  const [clipboard, setClipboard] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const queue = useRef<{ action: string; args: Record<string, unknown> }[]>([]);
  const inFlight = useRef<string | undefined>(undefined);
  const send = (body: unknown) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(body));
  };
  const drain = () => {
    if (inFlight.current || !grant.current || !queue.current.length) return;
    const action = queue.current.shift()!;
    inFlight.current = crypto.randomUUID();
    send({ type: "input", intentId: inFlight.current, ...grant.current, deadline: Date.now() + 10000, ...action });
    setPending(queue.current.length + 1);
  };
  const input = (action: string, args: Record<string, unknown>) => {
    if (!grant.current) return;
    if (queue.current.length >= 32) { setError("Espera a que termine la entrada anterior."); return; }
    queue.current.push({ action, args });
    drain();
  };
  const reset = () => {
    grant.current = undefined;
    queue.current = [];
    inFlight.current = undefined;
    setControlling(false);
    setPending(0);
  };
  const release = () => {
    const receipt = grant.current;
    queue.current = [];
    if (receipt) send({ type: "release", nonce: receipt.nonce });
    reset();
  };
  useEffect(() => {
    alive.current = true;
    let retry: ReturnType<typeof setTimeout>;
    let frames: WebSocket | undefined;
    const base = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/kitties/${encodeURIComponent(id)}/desktop`;
    const connect = () => {
      if (!alive.current) return;
      reset();
      const control = new WebSocket(`${base}/control`);
      socket.current = control;
      control.onmessage = (event) => {
        if(event.data==='pong')return;
        const body = JSON.parse(String(event.data));
        if (body.type === "connected") { setStatus("Conectado"); setError(""); }
        if (body.type === "grant") {
          grant.current = body.receipt;
          setControlling(true);
          canvas.current?.focus();
        }
        if (body.type === "held") setError(t("The desktop is busy. Try again."));
        if (body.type === "control_revoked") reset();
        if (body.type === "error") { reset(); setError(t("Control was lost. You can take it again.")); }
        if (body.type === "ack" && body.intentId === inFlight.current) {
          inFlight.current = undefined;
          if (body.status !== "completed") { reset(); setError(t("Could not confirm the input.")); }
          else {
            if (body.result && queue.current.length === 0) setClipboard(body.result);
            setPending(queue.current.length);
            drain();
          }
        }
      };
      control.onclose = () => {
        reset();
        setStatus(t("Reconnecting…"));
        frames?.close();
        if (alive.current) retry = setTimeout(connect, 1500);
      };
      control.onerror = () => control.close();
      const viewer = new WebSocket(`${base}/frames`);
      frames = viewer;
      viewer.binaryType = "arraybuffer";
      viewer.onclose=()=>{if(alive.current&&frames===viewer&&control.readyState===WebSocket.OPEN)control.close();};
      viewer.onerror=()=>viewer.close();
      viewer.onmessage = async (event) => {
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 8) return;
        const view = new DataView(event.data);
        const seq = view.getUint32(4);
        try {
          const picture = await createImageBitmap(new Blob([event.data.slice(8)], { type: "image/jpeg" }));
          if (alive.current && canvas.current) {
            canvas.current.width = picture.width;
            canvas.current.height = picture.height;
            canvas.current.getContext("2d")?.drawImage(picture, 0, 0);
          }
          picture.close();
        } finally {
          if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify({ type: "frame_ack", seq }));
        }
      };
    };
    connect();
    const heartbeat=setInterval(()=>{for(const peer of [socket.current,frames])if(peer?.readyState===WebSocket.OPEN)peer.send('ping');},20000);
    return () => { alive.current = false; clearTimeout(retry);clearInterval(heartbeat); release(); socket.current?.close(); frames?.close(); };
  }, [id]);
  const point = (event: MouseEvent) => {
    const el = canvas.current!, rect = el.getBoundingClientRect();
    return { x: Math.min(el.width - 1, Math.max(0, Math.round((event.clientX - rect.left) * el.width / rect.width))),
      y: Math.min(el.height - 1, Math.max(0, Math.round((event.clientY - rect.top) * el.height / rect.height))) };
  };
  return <section class="ws-desktop" aria-label="Escritorio">
    <header><strong>{status}</strong><span>{pending ? `${pending} entradas pendientes` : ""}</span>
      <button onClick={() => controlling ? release() : send({ type: "grant" })}>{controlling ? "Devolver control" : "Tomar control"}</button>
      <button onClick={onClose}>{t("Close")}</button></header>
    {error && <p role="alert">{error}</p>}
    <canvas ref={canvas} tabIndex={0} aria-label="Pantalla remota" style={{ width: "100%", background: "#151821", touchAction: "none" }}
      onClick={(e) => input("click", { ...point(e), button: 1 })}
      onContextMenu={(e) => { e.preventDefault(); input("click", { ...point(e), button: 3 }); }}
      onWheel={(e) => { if (!grant.current) return; e.preventDefault(); input("scroll", { direction: e.deltaY < 0 ? "up" : "down", amount: 3 }); }}
      onKeyDown={(e) => {
        if (!grant.current) return;
        e.preventDefault();
        const key = xKeys(e);
        if (key) input("key", { key });
        else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) input("type", { text: e.key });
      }} />
    <footer><input aria-label="Portapapeles" value={clipboard} onInput={(e) => setClipboard(e.currentTarget.value)} />
      <button disabled={!controlling} onClick={() => input("clipboard_write", { text: clipboard })}>{t("Copy to desktop")}</button>
      <button disabled={!controlling} onClick={() => input("clipboard_read", {})}>{t("Read clipboard")}</button></footer>
  </section>;
}
