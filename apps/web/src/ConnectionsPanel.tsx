import { useState, useEffect } from "preact/hooks";
import type { ConnectionView } from "@kitties/domain/entities";
import { call } from "./next-api";
import { t } from "./i18n";
type Connection = typeof ConnectionView.Type;
const nativeUrls = { google: "https://www.googleapis.com", m365: "https://graph.microsoft.com/v1.0" };
export default function ConnectionsPanel() {
  const [connections, setConnections] = useState<readonly Connection[]>([]), [auth, setAuth] = useState<Record<string, string>>({});
  const [name, setName] = useState(""), [url, setUrl] = useState(""), [token, setToken] = useState(""), [kind, setKind] = useState<Connection["kind"]>("mcp"), [allowReads, setAllowReads] = useState(false), [status, setStatus] = useState("");
  const [readTools,setReadTools]=useState("");
  const [signIn, setSignIn] = useState(""), [clientId, setClientId] = useState(""), [clientSecret, setClientSecret] = useState(""), [scope, setScope] = useState(""), [link, setLink] = useState("");
  const refresh = async () => {
    const items = await call(api => api.connections.list()); setConnections(items);
    const states = await Promise.all(items.map(async item => [item.id, (await call(api => api.connections.oauthStatus({ params: { id: item.id } }))).status]));
    setAuth(Object.fromEntries(states));
  };
  useEffect(() => { void refresh().catch(() => setStatus(t("Could not load connections."))); }, []);
  const attempt = (fn: () => Promise<unknown>) => { setStatus(""); void fn().catch(() => setStatus(t("Could not complete the operation. Check the connection and try again."))); };
  const native = kind === "google" || kind === "m365";
  return <section><h3>{t("Tools and connections")}</h3><p>{t("Actions need your approval. You can allow reads for each connection.")}</p>
    {connections.map(connection => <div class="next-provider" key={connection.id}><strong>{connection.name}</strong><span>{connection.kind} · {connection.url}</span><small>{t(({ ready: "Connected", refreshing: "Refreshing authorization…", reauthorize: "Sign in again", disconnected: "No OAuth authorization" })[auth[connection.id] ?? "disconnected"] ?? "Sign in again")}</small>
      <button onClick={() => attempt(async () => { const result = await call(api => api.connections.test({ params: { id: connection.id } })); setStatus(t("{count} tools available.", { count: result.tools.length })); })}>{t("Test")}</button>
      <button onClick={() => { setSignIn(connection.id); setClientId(""); setClientSecret(""); setScope(""); setLink(""); }}>{t("Sign in")}</button>
      {auth[connection.id] !== "disconnected" && <button onClick={() => attempt(async () => { await call(api => api.connections.oauthDisconnect({ params: { id: connection.id } })); await refresh(); })}>{t("Disconnect")}</button>}
      <button onClick={() => attempt(async () => { await call(api => api.connections.remove({ params: { id: connection.id } })); await refresh(); })}>{t("Remove")}</button>
      {signIn === connection.id && <form onSubmit={event => { event.preventDefault(); attempt(async () => { const result = await call(api => api.connections.oauthStart({ params: { id: connection.id }, payload: { ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}), ...(scope ? { scope } : {}) } })); setClientSecret(""); setLink(result.url); }); }}>
        <p>{t("Register the redirect address shown by discovery in your OAuth app. MCP servers can register automatically when supported.")}</p>
        <button type="button" onClick={() => attempt(async () => { const metadata = await call(api => api.connections.oauthDiscover({ params: { id: connection.id } })); const value = metadata as { redirectUri: string }; setStatus(t("Redirect address: {url}", { url: value.redirectUri })); })}>{t("Discover authorization")}</button>
        <label>{t("Client ID (optional)")}<input value={clientId} onInput={event => setClientId(event.currentTarget.value)} /></label>
        <label>{t("Client secret (optional)")}<input type="password" autoComplete="off" value={clientSecret} onInput={event => setClientSecret(event.currentTarget.value)} /></label>
        <label>{t("Scopes (optional)")}<input value={scope} onInput={event => setScope(event.currentTarget.value)} /></label><button>{t("Prepare sign-in")}</button>
        {link && <p><a href={link} target="_blank" rel="noopener noreferrer">{t("Continue to authorization")}</a><button type="button" onClick={() => attempt(refresh)}>{t("I have finished signing in")}</button></p>}
      </form>}
    </div>)}
    <form onSubmit={event => { event.preventDefault(); attempt(async () => { await call(api => api.connections.save({ params: { id: crypto.randomUUID() }, payload: { name, url: native ? nativeUrls[kind] : url, kind, token, allowReads, readTools:readTools.split(",").map(value=>value.trim()).filter(Boolean) } })); setToken(""); setName(""); setUrl(""); await refresh(); }); }}>
      <label>{t("Name")}<input required value={name} onInput={event => setName(event.currentTarget.value)} /></label>
      <label>{t("Type")}<select value={kind} onChange={event => setKind(event.currentTarget.value as Connection["kind"])}><option value="mcp">MCP</option><option value="http">HTTP</option><option value="ntfy">ntfy</option><option value="google">Google Workspace</option><option value="m365">Microsoft 365</option></select></label>
      {!native && <label>{t("HTTPS address")}<input type="url" required value={url} onInput={event => setUrl(event.currentTarget.value)} /></label>}
      {!native && <label>{t("Token (optional)")}<input type="password" autoComplete="off" value={token} onInput={event => setToken(event.currentTarget.value)} /></label>}
      <label>{t("MCP read tool names (comma separated)")}<input value={readTools} onInput={event=>setReadTools(event.currentTarget.value)}/></label><label class="next-check"><input type="checkbox" checked={allowReads} onChange={event => setAllowReads(event.currentTarget.checked)} />{t("Allow reads without asking")}</label><button class="primary">{t("Save connection")}</button>
    </form><p role="status">{status}</p>
  </section>;
}
