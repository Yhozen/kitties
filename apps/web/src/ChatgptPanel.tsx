import { useEffect, useState } from "preact/hooks";
import type { ChatgptAccountView, ChatgptLinkView, ChatgptProbeView } from "@kitties/domain/entities";
import { call } from "./next-api";
import { t } from "./i18n";
type Account = typeof ChatgptAccountView.Type;
type Link = typeof ChatgptLinkView.Type;
type Probe = typeof ChatgptProbeView.Type;
export default function ChatgptPanel() {
  const [accounts,setAccounts]=useState<readonly Account[]>([]),[selected,setSelected]=useState("");
  const [attempt,setAttempt]=useState<Link>(),[probe,setProbe]=useState<Probe>(),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const query = new URLSearchParams(location.search), callback = query.get("chatgptCallback");
  const refresh=async()=>setAccounts(await call(a=>a.chatgpt.accounts()));
  const run=(fn:()=>Promise<unknown>)=>{setError("");setBusy(true);void fn().catch(()=>setError(t("Could not complete the operation."))).finally(()=>setBusy(false));};
  useEffect(()=>{void refresh().catch(()=>{});const pending=localStorage.getItem("chatgpt-link-attempt");if(pending)void call(a=>a.chatgpt.attempt({params:{id:pending}})).then(value=>{setAttempt(value);if(value.canRetryRegistration)setSelected("retry:"+value.id);}).catch(()=>localStorage.removeItem("chatgpt-link-attempt"));const id=query.get("chatgptProbe");if(id){history.replaceState(null,"","/?panel=settings");run(async()=>{setProbe(await call(a=>a.chatgpt.probe({params:{id}})));await refresh();});}},[]);
  useEffect(()=>{
    if(!attempt || !["pending","exchanging"].includes(attempt.status))return;
    const timer=setInterval(()=>{void call(a=>a.chatgpt.attempt({params:{id:attempt.id}})).then(setAttempt).catch(()=>{});},2000);
    return()=>clearInterval(timer);
  },[attempt?.id,attempt?.status]);
  const connect=async()=>{
    if(!callback)return;
    const attempt=await call(a=>a.chatgpt.link({payload:{redirectUri:callback,...(selected.startsWith("retry:")?{retryAttemptId:selected.slice(6)}:selected?{accountId:selected,requestConsent:accounts.find(account=>account.id===selected)?.status==="consent_required"}:{})}}));
    localStorage.setItem("chatgpt-link-attempt",attempt.id);setAttempt(attempt);location.assign(`/v1/chatgpt/link-attempts/${encodeURIComponent(attempt.id)}/authorize`);
  };
  return <section>
    <h3>{t("Use your ChatGPT plan")}</h3>
    <p>{t("Link once using the Mac helper. After linking, Puppies works from the PWA on any device.")}</p>
    <p>{t("ChatGPT plan usage is not available yet. Verify your connection to check access.")}</p>
    {!callback&&<p>{t("On your Mac, run:")} <code>pnpm chatgpt:connect --stage {location.hostname.startsWith("next.")?"next":"prod"}</code></p>}
    {accounts.map(account=><div class="next-provider" key={account.id}>
      <strong>{account.label}</strong><small>{account.status}</small><span>{account.clientId}</span>
      <small>{account.admittedAt?t("Responses connection verified"):t("Responses connection not yet verified")}</small>
      <button disabled={busy||account.status!=="connected"} onClick={()=>run(async()=>{setProbe(await call(a=>a.chatgpt.probe({params:{id:account.id}})));await refresh();})}>{t("Verify connection")}</button>
      <button disabled={busy} onClick={()=>run(async()=>{const result=await call(a=>a.chatgpt.disconnect({params:{id:account.id}}));setNotice(result.revocationConfirmed?t("Disconnected"):t("Disconnected locally. Remote revocation was not confirmed; disconnect Kitties in ChatGPT Settings."));await refresh();})}>{t("Disconnect")}</button>
    </div>)}
    {callback&&<form onSubmit={event=>{event.preventDefault();run(connect);}}>
      <label>{t("ChatGPT account")}<select value={selected} onChange={e=>setSelected(e.currentTarget.value)}><option value="">{t("Add account or workspace")}</option>{attempt?.canRetryRegistration&&<option value={"retry:"+attempt.id}>{t("Retry previous registration")}</option>}{accounts.map(account=><option value={account.id}>{account.label}</option>)}</select></label>
      <button data-oai-siwc-button disabled={busy}>{t("Continue with ChatGPT")}</button>
    </form>}
    {attempt&&<p role="status">{attempt.status}{attempt.error&&` · ${attempt.error.code}`} { ["pending","exchanging"].includes(attempt.status)&&<button onClick={()=>run(async()=>setAttempt(await call(a=>a.chatgpt.cancel({params:{id:attempt.id}}))))}>{t("Cancel")}</button>}</p>}
    {probe&&<p role="status">{probe.ok?t("Responses connection verified"): `${probe.error?.reason}: ${probe.error?.code}`}{probe.error?.requestId&&` · ${probe.error.requestId}`}</p>}
    <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">{t("Manage usage")}</a>
    <p role="status">{notice}{error}</p>
  </section>;
}
