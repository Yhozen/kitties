import {useEffect,useState} from "preact/hooks";
import type {RecoveryView,RecoveryKind} from "@kitties/domain/recovery";
import {call} from "./next-api";
import {t} from "./i18n";
export default function RecoveryPanel(){
 const [state,setState]=useState<typeof RecoveryView.Type>(),[error,setError]=useState(""),[selected,setSelected]=useState(""),[bookmark,setBookmark]=useState(""),[at,setAt]=useState(""),[busy,setBusy]=useState(false);
 const refresh=async()=>setState(await call(a=>a.recovery.status()));
 const run=(fn:()=>Promise<unknown>)=>{setBusy(true);setError("");void fn().then(refresh).catch(()=>setError(t("Recovery could not complete. Refresh to see its status."))).finally(()=>setBusy(false));};
 useEffect(()=>{run(refresh);const timer=setInterval(()=>void refresh().catch(()=>{}),10000);return()=>clearInterval(timer);},[]);
 const object=()=>{const [kind,...name]=selected.split(":");return{kind:kind as typeof RecoveryKind.Type,name:name.join(":")};};
 return <section><h3>{t("Backups and recovery")}</h3><p>{t("Encrypted exports are locked for 30 days and retained for 90 days. Point-in-time recovery is available for 30 days.")}</p>{error&&<p role="alert">{error}</p>}{state&&<>
 <p>{state.control.mode==="ready"?t("Ready"):t("Recovery in progress")}</p>
 <button disabled={busy||state.control.mode!=="ready"} onClick={()=>run(()=>call(a=>a.recovery.export({payload:{operationId:crypto.randomUUID()}})))}>{t("Create encrypted export")}</button>
 <button disabled={busy} onClick={()=>run(refresh)}>{t("Refresh")}</button>
 {state.exports.map(row=><p key={row.id}>{new Date(row.at).toLocaleString()} · {row.status} · {row.objects??0} {t("objects")} · <code>{row.id}</code>{row.status!=="completed"&&<button disabled={busy} onClick={()=>run(()=>call(a=>a.recovery.resume({payload:{kind:"export",operationId:row.id}})))}>{t("Continue")}</button>}</p>)}
 <details><summary>{t("Restore an object")}</summary><p>{t("Restoring pauses older tasks for review, disconnects desktops, and requires signing in to connections again.")}</p>
 <label>{t("Object")}<select value={selected} onChange={e=>{setSelected(e.currentTarget.value);setBookmark("");}}><option value="">{t("Choose an object")}</option>{state.objects.map(o=><option value={`${o.kind}:${o.name}`}>{o.kind} · {o.name}</option>)}</select></label>
 <label>{t("Time (leave empty for now)")}<input type="datetime-local" value={at} onInput={e=>setAt(e.currentTarget.value)}/></label>
 <button disabled={busy||!selected} onClick={()=>run(async()=>{const value=await call(a=>a.recovery.bookmark({payload:{...object(),...(at?{at:new Date(at).getTime()}: {})}}));setBookmark(value.bookmark);} )}>{t("Get recovery bookmark")}</button>
 <label>{t("Recovery bookmark")}<input value={bookmark} onInput={e=>setBookmark(e.currentTarget.value)}/></label>
 <button disabled={busy||!bookmark||!selected||state.control.mode!=="ready"} onClick={()=>{if(window.confirm(t("Restore this object and pause older tasks?")))run(()=>call(a=>a.recovery.restore({payload:{operationId:crypto.randomUUID(),...object(),bookmark}})));}}>{t("Restore")}</button>
 </details>
 {state.restores.map(row=><p key={row.id}>{new Date(row.at).toLocaleString()} · {row.kind} · {row.status}{row.status!=="completed"&&<button disabled={busy} onClick={()=>run(()=>call(a=>a.recovery.resume({payload:{kind:"restore",operationId:row.id}})))}>{t("Continue")}</button>}</p>)}
 {state.reviews.length>0&&<p>{state.reviews.length} {t("older tasks require review. Start a new request to continue safely.")}</p>}
 <details><summary>{t("Journal retention")}</summary><p>{t("Completed activity journals are purged after 30 days. Completed request receipts are kept to prevent duplicate actions.")}</p><button disabled={busy} onClick={()=>run(()=>call(a=>a.recovery.purge({payload:{operationId:crypto.randomUUID()}})))}>{t("Run retention job")}</button>{state.purges.map(row=><p key={row.id}>{new Date(row.at).toLocaleString()} · {row.status}</p>)}</details>
 </>}</section>;
}
