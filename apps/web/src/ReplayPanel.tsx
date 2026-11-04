import { t } from "./i18n";
import { useEffect, useState } from "preact/hooks";
import { call } from "./next-api";
export default function ReplayPanel({ chatId }: { chatId: string }) {
  const [frames, setFrames] = useState<readonly { messageId: string; callId: string; screenshot: string }[]>([]), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false), [error, setError] = useState("");
  useEffect(() => { let active = true; setIndex(0); setPlaying(false); void call(api => api.chats.replay({ params: { id: chatId } })).then(result => { if (active) setFrames(result); }).catch(() => setError(t("Could not load the replay."))); return () => { active = false; }; }, [chatId]);
  useEffect(() => { if (!playing || !frames.length) return; const timer = setInterval(() => setIndex(current => { if (current + 1 >= frames.length) { setPlaying(false); return current; } return current + 1; }), 1500); return () => clearInterval(timer); }, [playing, frames.length]);
  const frame = frames[index];
  return <section class="next-replay"><h3>{t("Desktop replay")}</h3>{error && <p role="alert">{error}</p>}{frame ? <><img src={`/v1/artifacts/${encodeURIComponent(frame.screenshot)}`} alt={`Paso ${index + 1} de ${frames.length}`} onError={() => setError(t("This screenshot is no longer available."))} style={{ maxWidth: "100%", maxHeight: "60vh" }} /><div><button disabled={!index} onClick={() => setIndex(index - 1)}>{t("Previous")}</button><button onClick={() => { if (index === frames.length - 1) setIndex(0); setPlaying(!playing); }}>{playing ? t("Pause") : t("Play")}</button><button disabled={index >= frames.length - 1} onClick={() => setIndex(index + 1)}>{t("Next")}</button><span>{index + 1} / {frames.length}</span></div></> : <p>{t("No screenshots in this conversation yet.")}</p>}</section>;
}
