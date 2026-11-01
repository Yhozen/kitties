import { useEffect, useState } from "preact/hooks";
import type { ProviderView } from "@kitties/domain/entities";
import { call } from "./next-api";
import { t } from "./i18n";
export default function ChatgptPanel({ providers }: { providers: readonly typeof ProviderView.Type[] }) {
  const [states,setStates]=useState<Record<string,string>>({}),[selected,setSelected]=useState(""),[link,setLink]=useState(""),[callback,setCallback]=useState(""),[error,setError]=useState("");
  const refresh=async()=>setStates(Object.fromEntries(await Promise.all(providers.filter(p=>p.kind==="chatgpt").map(async p=>[p.id,(await call(a=>a.signin.status({params:{id:p.id}}))).status]))));
  useEffect(()=>{void refresh().catch(()=>{});},[providers]);
  const attempt=(fn:()=>Promise<unknown>)=>{setError("");void fn().catch(()=>setError(t("Could not complete sign-in. Start again.")));};
  return <section><h3>ChatGPT</h3>{providers.filter(p=>p.kind==="chatgpt").map(p=><div class="next-provider"><strong>{p.name}</strong><small>{t(states[p.id]==="ready"?"Connected":"Sign in again")}</small><button onClick={()=>attempt(async()=>{setSelected(p.id);setCallback("");setLink((await call(a=>a.signin.start({params:{id:p.id}}))).url);})}>{t("Sign in with ChatGPT")}</button><button onClick={()=>attempt(async()=>{await call(a=>a.signin.disconnect({params:{id:p.id}}));await refresh();})}>{t("Disconnect")}</button></div>)}{link&&<form onSubmit={e=>{e.preventDefault();attempt(async()=>{await call(a=>a.signin.finish({params:{id:selected},payload:{url:callback}}));setCallback("");setLink("");await refresh();});}}><a href={link} target="_blank" rel="noopener noreferrer">{t("Continue to authorization")}</a><p>{t("After signing in, copy the localhost callback address from your browser and paste it here.")}</p><label>{t("Callback address")}<input type="url" required autoComplete="off" value={callback} onInput={e=>setCallback(e.currentTarget.value)}/></label><button>{t("Finish sign-in")}</button></form>}<p role="status">{error}</p></section>;
}
