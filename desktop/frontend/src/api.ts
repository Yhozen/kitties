// The gateway, from the browser or from inside the Wails app.
//
// In Wails the Go side owns the connection (URL and token) and proxies every call through the
// bound App.Request method, so the page never holds the token. In a browser the page talks to
// the gateway itself: same-origin through vite's proxy, or the URL and token the person gave.

export interface Kitty {
  id: string;
  name: string;
  provider: string;
  desktop: boolean;
  container?: string;
  // starting: its desktop is coming up (the first time, its image downloads).
  status: "created" | "starting" | "running" | "stopping" | "sleeping" | "stopped" | "error";
  availability?: "enabled" | "sleeping" | "disabled";
  computer?: {
    runtime?: string;
    id?: string;
    owner_id?: string;
    generation?: number;
    checkpoint_id?: string;
  };
  operation?: { kind?: string; started_at?: string };
  error?: string;
  connectors?: string[];
  soul: { name?: string; persona?: string; tone?: string; traits?: string[]; skills?: string[] };
  avatar: { breed: string; color: string };
  // Limits bound one task; zero fields take the defaults. Backup takes over a task this kitty gives up on.
  limits?: Limits;
  backup?: string;
  // approvals is "ask" (the default: an action that reaches other people waits for a yes until
  // the kitty is trusted with it) or "auto".
  approvals?: "ask" | "auto" | "";
  // theme is the look of its desktop (a Lumen (Openbox) theme); empty is the image's own, Numix (dark).
  theme?: string;
}

// THEMES are the looks a kitty's desktop can wear, as the gateway knows them.
export const THEMES: [string, string][] = [
  ["", "Numix"],
  ["Greybird-dark", "Greybird"],
];

// Approval is an action a kitty wants to take and is waiting to be allowed.
export interface Approval {
  id: string;
  kitty: string;
  kitty_name: string;
  connector: string;
  kind: string;
  action: string;
  args: Record<string, unknown>;
  summary: string;
  risk: "ask" | "always";
  chat?: string;
  status: "pending" | "approved" | "rejected";
  reason?: string;
  always?: boolean;
  at: string;
  decided_at?: string;
  result?: string;
  error?: string;
}

// ApprovalRule is what the person allowed for good.
export interface ApprovalRule {
  id: string;
  kitty: string;
  kitty_name?: string;
  connector: string;
  action: string;
  mode: "auto" | "ask" | "never";
  created: string;
}

export interface MemoryNote {
  id: string;
  scope: string;
  text: string;
  strength: number;
  source: string;
  pinned?: boolean;
  updated: string;
}

export interface MemoryProfile {
  demand: number;
  auto: boolean;
  up: number;
  down: number;
  pending: number;
}

// MemoryView is what a kitty knows about the person and how demanding they are.
export interface MemoryView {
  notes: MemoryNote[];
  profile: MemoryProfile;
  level: string;
  trust?: Record<string, { streak: number; needs: number }>;
  // What it used today against its daily limits (a limit of 0 is none).
  spent?: { tokens: number; actions: number; day_tokens: number; day_actions: number };
}

export interface Limits {
  max_tokens?: number;
  max_seconds?: number;
  max_rounds?: number;
  retries?: number;
  // The day's ceiling over all its work: tokens, and actions that reach other people.
  day_tokens?: number;
  day_actions?: number;
}

// Goal is something a kitty pursues on its own: on a schedule (every, a cron expression),
// when a connector reports an event (on), or when a person runs it.
export interface Goal {
  id: string;
  kitty: string;
  title: string;
  text: string;
  every?: string;
  on?: string[];
  enabled: boolean;
  chat?: string;
  created_at: string;
  last_run?: string;
  next_run?: string;
  runs: number;
  last_result?: string;
  from_file?: boolean;
}

// JournalEntry is one line of a kitty's journal: what it did and where it got stuck.
export interface JournalEntry {
  at: string;
  kitty: string;
  kind:
    | "run"
    | "done"
    | "blocked"
    | "retry"
    | "escalated"
    | "delegated"
    | "recovered"
    | "skipped"
    | "event";
  text: string;
  goal?: string;
  chat?: string;
}

// Delegation is a subtask one kitty handed to another.
export interface Delegation {
  kitty: string;
  kitty_id: string;
  chat: string;
  task: string;
  result?: string;
  error?: string;
}

export interface Step {
  at: string;
  action: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
  shot?: string;
}

export interface Turn {
  at: string;
  from: string;
  kitty?: string;
  text: string;
  calls?: { name: string; kind?: string; output?: string; error?: string; artifact?: string }[];
  steps?: Step[];
  artifacts?: string[];
  skills?: string[];
  // resumable: the task stopped on its budget and can go on from where it was.
  resumable?: boolean;
  interrupted?: boolean;
  working?: boolean;
  needs_help?: boolean;
  delegations?: Delegation[];
  approvals?: { id: string; connector: string; action: string; summary: string }[];
  feedback?: "up" | "down" | "";
  // detail is the technical form of what the text says in plain words (an error as written).
  detail?: string;
  // limits are the limits the kitty set on itself in this turn (an empty mode lifted one).
  limits?: { connector: string; action: string; mode: string; previous?: string }[];
  usage?: { input: number; output: number };
}

export interface Session {
  id: string;
  title: string;
  members: string[];
  turns?: Turn[];
  created_at: string;
  updated_at: string;
  goal?: string;
  owner?: string;
  depth?: number;
  needs_help?: boolean;
}

export interface ProviderKind {
  Name: string;
  Family: string;
  BaseURL: string;
  KeyEnv: string;
  NoKey: boolean;
  DefaultModel: string;
  // Login names the account a profile of this kind can sign in with instead of a key.
  Login?: string;
}

// Account is one sign-in a profile can think on instead of a key.
export interface Account {
  kind: string;
  signed_in: boolean;
  who?: string;
  available: boolean;
  note?: string;
}

// LoginFlow is a sign-in in progress: open url (and type code), or paste back where the browser
// landed.
export interface LoginFlow {
  id: string;
  kind: string;
  method: "device" | "browser" | "instant";
  url?: string;
  code?: string;
  paste?: boolean;
  status: "pending" | "connected" | "failed";
  error?: string;
  who?: string;
}

export interface ProviderView {
  // used_by names the kitties that think with it.
  used_by?: string[];
  name: string;
  kind: string;
  model: string;
  base_url?: string;
  api_key_set: boolean;
  api_key_env?: string;
  // auth is "login" when it thinks on a signed-in account instead of a key.
  auth?: string;
  max_tokens?: number;
  temperature?: number;
  default: boolean;
  describe: string;
  from_file: boolean;
  error?: string;
}

export interface ConnectorView {
  // used_by names the kitties allowed to use it.
  used_by?: string[];
  name: string;
  kind: string;
  category: string;
  label: string;
  description?: string;
  url?: string;
  token_set: boolean;
  chat_id?: string;
  command?: string;
  settings: Record<string, string>;
  secrets_set: string[];
  from_file: boolean;
  oauth?: string;
  signed_in?: boolean;
  needs_sign_in?: boolean;
  account?: string;
  // auth is how one that signs in reaches its account: "sign-in", "keys", "token", "webhook".
  auth?: string;
  // token_expires is when a typed token of a known lifetime stops working (RFC 3339).
  token_expires?: string;
}

// ConnectorTest is what testing a connection answered: tested false when it cannot be tested
// without acting.
export interface ConnectorTest {
  ok: boolean;
  tested: boolean;
  account?: string;
  error?: string;
  message?: string;
}

export interface ChatEvent {
  type: "hello" | "turn" | "update" | "done" | "deleted";
  session?: string;
  index?: number;
  turn?: Turn;
}

export interface ConnectorField {
  name: string;
  label: string;
  help?: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  // key groups the fields that, all filled in, stand for the sign-in ("token", "oauth1",
  // "webhook").
  key?: string;
  // lifetime is how long, in seconds, a token typed in the field lasts.
  lifetime?: number;
}

export interface ConnectorKind {
  name: string;
  category: string;
  label: string;
  help: string;
  fields: ConnectorField[];
  actions: { name: string; help: string; args?: string[]; risk?: "ask" | "always" }[];
  oauth?: string;
  inbound?: boolean;
}

export interface SettingsView {
  providers: ProviderView[];
  connectors: ConnectorView[];
  default_provider: string;
  kinds: ProviderKind[];
  connector_kinds: string[];
  connector_catalog: ConnectorKind[];
  connector_categories: string[];
  motita_url?: string;
  // day starts the summary with the person's day: calendar, reminders and weather.
  notify: { connector: string; on: string[]; digest?: string; day?: boolean };
  notify_events: string[];
  accounts: Account[];
  // oauth_ready are the services a connection signs in to without an app of the person's own.
  oauth_ready?: string[];
}

export interface Skill {
  name: string;
  title: string;
  summary: string;
  body?: string;
  builtin: boolean;
  proposed: boolean;
  updated_at: string;
}

export interface ArtifactInfo {
  name: string;
  type: string;
  size: number;
  updated_at: string;
  by?: string;
}

export interface ProviderInfo {
  name: string;
  kind: string;
  model: string;
  describe: string;
}

interface WailsApp {
  Request(method: string, path: string, body: string): Promise<string>;
  Gateway(): Promise<{ url: string; token: string }>;
  GatewayNote(): Promise<string>;
  Connect(url: string, token: string): Promise<string>;
}

declare global {
  interface Window {
    go?: { main?: { App?: WailsApp } };
  }
}

export const inWails = (): boolean => Boolean(window.go?.main?.App);

// The Android app is this same page inside a WebView; it adds a bridge to open links outside.
interface AndroidBridge {
  open(url: string): void;
}

export const androidBridge = (): AndroidBridge | undefined =>
  (window as unknown as { KittiesAndroid?: AndroidBridge }).KittiesAndroid;

export const inAndroid = (): boolean => Boolean(androidBridge());

// errText is the words of whatever was thrown: Wails rejects with a plain string.
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const KEY = "kitties.gateway";

export interface Connection {
  url: string;
  token: string;
}

// A link can carry the token (?token=...): the gateway's own page and a shared link use it. It is
// saved once and dropped from the address bar. The gateway's address never comes from a link: a
// link could point the page, and the token it holds, at another server.
(function connectionFromLink() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has("token")) {
      const saved = savedConnection();
      saveConnection({ url: saved.url, token: q.get("token") ?? saved.token });
      q.delete("token");
      const rest = q.toString();
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    }
  } catch {
    /* no history in this context */
  }
})();

export function savedConnection(): Connection {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { url: safeGatewayBase(raw.url || ""), token: raw.token || "" };
  } catch {
    return { url: "", token: "" };
  }
}

export function saveConnection(c: Connection): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private window */
  }
}

// cookieLogin says whether this page signs in with a session cookie: served by the gateway
// itself (or a proxy in front of it), not inside Wails and not pointed at another address.
export function cookieLogin(): boolean {
  const c = savedConnection();
  return !inWails() && !inAndroid() && !c.url && !c.token;
}

// fixSettings fills what an older gateway leaves out of the settings (or sends as null), so a
// page newer than its gateway shows empty lists instead of failing to draw.
function fixSettings<T>(path: string, data: T): T {
  if (
    !path.startsWith("/v1/settings") ||
    !data ||
    typeof data !== "object" ||
    !("providers" in data)
  ) {
    return data;
  }
  const v = data as unknown as Record<string, unknown>;
  for (const k of [
    "providers",
    "connectors",
    "kinds",
    "connector_kinds",
    "connector_catalog",
    "connector_categories",
    "notify_events",
    "accounts",
    "oauth_ready",
  ]) {
    if (!Array.isArray(v[k])) {
      v[k] = [];
    }
  }
  const n = (v.notify || {}) as { connector?: string; on?: string[] };
  v.notify = { ...n, connector: n.connector || "", on: Array.isArray(n.on) ? n.on : [] };
  return data;
}

// request performs one API call and returns its JSON.
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const app = window.go?.main?.App;
  if (app) {
    // A reading that gets no answer from the app fails with a message instead of leaving the
    // screen waiting for good (a message that never comes back through the webview's bridge).
    // Writes may legitimately take minutes, so only reads have a limit.
    // Wails rejects with a plain string, not an Error: keep its words.
    const call = app
      .Request(method, path, body === undefined ? "" : JSON.stringify(body))
      .catch((e: unknown) => {
        throw new ApiError(0, e instanceof Error ? e.message : String(e));
      });
    const raw = await (method === "GET"
      ? Promise.race([
          call,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new ApiError(0, `the app got no answer for ${method} ${path} in 20 s`)),
              20_000,
            ),
          ),
        ])
      : call);
    const parsed = JSON.parse(raw) as { status: number; body: string };
    const data = parsed.body ? JSON.parse(parsed.body) : {};
    if (parsed.status >= 400) {
      throw new ApiError(parsed.status, data.error || `HTTP ${parsed.status}`);
    }
    return fixSettings(path, data as T);
  }
  let conn = savedConnection();
  if (inAndroid() && (!conn.url || !conn.token)) {
    // The app has no gateway of its own: it asks for the address and the token first.
    throw new ApiError(401, "Connect the app to your Kitties gateway: its address and token.");
  }
  if (!conn.token) {
    conn = await fetchLocalToken(conn);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (conn.token) {
    headers.Authorization = "Bearer " + conn.token;
  }
  const res = await fetch(safeGatewayBase(conn.url) + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && conn.token) {
    // The gateway may have restarted with a new token: the local one is tried once more.
    const fresh = await fetchLocalToken({ url: conn.url, token: "" });
    if (fresh.token && fresh.token !== conn.token) {
      return request(method, path, body);
    }
  }
  const text = await res.text();
  let data: { error?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new ApiError(res.status, data.error || res.statusText);
  }
  return fixSettings(path, data as T);
}

// fetchLocalToken asks the gateway for its token, which it hands out only to this machine, and
// saves it. The page served by the gateway itself, or opened on the same computer, needs no typing.
async function fetchLocalToken(conn: Connection): Promise<Connection> {
  try {
    const res = await fetch(safeGatewayBase(conn.url) + "/v1/local-token");
    if (!res.ok) {
      return conn;
    }
    const data = (await res.json()) as { token?: string };
    if (data.token) {
      const next = { url: conn.url, token: data.token };
      saveConnection(next);
      return next;
    }
  } catch {
    /* not local, or not running */
  }
  return conn;
}

// gatewayAddress turns what a person typed into the gateway's address: a bare "host:port" is
// taken as http, and anything that is not an http(s) address is refused (null). Empty means this
// page's own gateway.
export function gatewayAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text) {
    return "";
  }
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "http://" + text;
  return safeGatewayBase(full) || null;
}

// sendsInTheClear says whether an address would carry the token unencrypted over a network that
// is not the person's own: plain http to a host that is not this computer or a home/office address.
export function sendsInTheClear(address: string): boolean {
  try {
    const u = new URL(address);
    if (u.protocol !== "http:") {
      return false;
    }
    const h = u.hostname;
    return !(
      h === "localhost" ||
      h === "[::1]" ||
      h.endsWith(".local") ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

// safeGatewayBase is the gateway address to build requests on: an http(s) address without a
// trailing slash, or "" (this page's own origin) for anything else.
function safeGatewayBase(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

// shotURL is where a screenshot can be loaded from as an image.
export function shotURL(path: string): string {
  const conn = savedConnection();
  const base = safeGatewayBase(conn.url);
  const sep = path.includes("?") ? "&" : "?";
  return conn.token ? `${base}${path}${sep}token=${encodeURIComponent(conn.token)}` : base + path;
}

// shotData loads a screenshot as a data: URL through the API (the only way inside Wails).
export async function shotData(
  path: string,
  mime = "image/png",
  signal?: AbortSignal,
): Promise<string> {
  const app = window.go?.main?.App;
  if (!app) {
    if (!signal) return shotURL(path);
    const response = await fetch(shotURL(path), { signal });
    if (!response.ok) throw await desktopResponseError(response);
    return URL.createObjectURL(await response.blob());
  }
  const raw = await app.Request("GET", path, "");
  const parsed = JSON.parse(raw) as { status: number; body: string; base64?: string };
  if (parsed.status >= 400 || !parsed.base64) {
    throw new ApiError(parsed.status, "no screenshot");
  }
  return `data:${mime};base64,` + parsed.base64;
}

export const api = {
  health: () =>
    request<{
      ok: boolean;
      version: string;
      containers: boolean;
      containers_state?: "not_installed" | "not_running";
      containers_error?: string;
      runtime?: string;
    }>("GET", "/v1/health"),
  kitties: () => request<{ kitties: Kitty[] }>("GET", "/v1/kitties").then((r) => r.kitties || []),
  kitty: (ref: string) =>
    request<{ kitty: Kitty }>("GET", `/v1/kitties/${ref}`).then((r) => r.kitty),
  createKitty: (spec: {
    name: string;
    provider?: string;
    soul?: Kitty["soul"];
    desktop?: boolean;
    avatar?: Kitty["avatar"];
    connectors?: string[];
  }) => request<{ kitty: Kitty; warning?: string }>("POST", "/v1/kitties", spec),
  editKitty: (
    ref: string,
    u: {
      provider?: string;
      connectors?: string[];
      avatar?: Kitty["avatar"];
      soul?: Kitty["soul"];
      limits?: Limits;
      backup?: string;
      approvals?: string;
      theme?: string;
    },
  ) => request<{ kitty: Kitty }>("PATCH", `/v1/kitties/${ref}`, u).then((r) => r.kitty),
  startKitty: (ref: string) => request("POST", `/v1/kitties/${ref}/start`),
  // controlKitty takes a kitty's display over (hold) or gives it back; inputKitty is a click,
  // keys or text of the person on it.
  controlKitty: (ref: string, hold: boolean, control_id = "") =>
    request<{ held: boolean; control_id?: string }>("POST", `/v1/kitties/${ref}/control`, {
      hold,
      control_id,
    }),
  inputKitty: (ref: string, control_id: string, action: string, args: Record<string, unknown>) =>
    request("POST", `/v1/kitties/${ref}/input`, { control_id, action, args }),
  // answerHelp is what the person answers a kitty that asked for help: told to it, or (secret)
  // typed on its desktop without showing it.
  answerHelp: (
    chat: string,
    turn: number,
    a: { text: string; secret: boolean; enter: boolean; save?: string },
  ) => request("POST", `/v1/chats/${chat}/turns/${turn}/help`, a),
  // updateStatus is the version of Kitties and the news of a newer one (refresh looks now);
  // applyUpdate installs the newer one, and the gateway restarts into it.
  updateStatus: (refresh = false) =>
    request<UpdateStatus>("GET", "/v1/update" + (refresh ? "?refresh=1" : "")),
  applyUpdate: () =>
    request<{ updated_to: string; restarting: boolean }>("POST", "/v1/update/apply"),
  // desktopInfo says whether a kitty's desktop has a newer image and when its sessions were backed
  // up; backupKitty backs them up now; updateKitty moves the desktop to the newest image.
  desktopInfo: (ref: string) => request<DesktopInfo>("GET", `/v1/kitties/${ref}/desktop`),
  backupKitty: (ref: string) => request("POST", `/v1/kitties/${ref}/backup`),
  updateKitty: (ref: string) => request("POST", `/v1/kitties/${ref}/update`),
  // vault lists the secrets a kitty may type (names and kitties, never values); saveSecret saves
  // one (with a value) or changes who may use it (without).
  vault: () => request<{ secrets: Secret[] }>("GET", "/v1/vault").then((r) => r.secrets || []),
  saveSecret: (name: string, body: { value?: string; kitties: string[] }) =>
    request<{ secrets: Secret[] }>("PUT", `/v1/vault/${encodeURIComponent(name)}`, body).then(
      (r) => r.secrets || [],
    ),
  deleteSecret: (name: string) =>
    request<{ secrets: Secret[] }>("DELETE", `/v1/vault/${encodeURIComponent(name)}`).then(
      (r) => r.secrets || [],
    ),
  // clipboard is the text on a kitty's clipboard; setClipboard gives it the person's.
  clipboard: (ref: string) =>
    request<{ text: string }>("GET", `/v1/kitties/${ref}/clipboard`).then((r) => r.text || ""),
  setClipboard: (ref: string, text: string) =>
    request("PUT", `/v1/kitties/${ref}/clipboard`, { text }),
  stopKitty: (ref: string) => request("POST", `/v1/kitties/${ref}/stop`),
  sleepKitty: (ref: string) => request("POST", `/v1/kitties/${ref}/sleep`),
  backupStatus: () => request<BackupStatus>("GET", "/v1/backups/status"),
  backupNow: () => request<BackupStatus>("POST", "/v1/backups"),
  recoveries: () =>
    request<{ recoveries: Recovery[] }>("GET", "/v1/recoveries").then((r) => r.recoveries || []),
  purgeRecovery: (ref: string) =>
    request("POST", `/v1/recoveries/${encodeURIComponent(ref)}/purge`),
  removeKitty: (ref: string) => request("DELETE", `/v1/kitties/${ref}`),
  // connectorNames are the connections a kitty may be given.
  connectorNames: () =>
    request<{ connectors: Record<string, string> }>("GET", "/v1/connectors").then((r) =>
      Object.keys(r.connectors || {}).sort(),
    ),
  providers: () =>
    request<{ providers: ProviderInfo[]; kinds: string[] }>("GET", "/v1/providers").then(
      (r) => r.providers || [],
    ),
  chats: () => request<{ chats: Session[] }>("GET", "/v1/chats").then((r) => r.chats || []),
  chat: (id: string) => request<{ chat: Session }>("GET", `/v1/chats/${id}`).then((r) => r.chat),
  createChat: (title: string, members: string[]) =>
    request<{ chat: Session }>("POST", "/v1/chats", { title, members }).then((r) => r.chat),
  deleteChat: (id: string) => request("DELETE", `/v1/chats/${id}`),
  addMembers: (id: string, members: string[]) =>
    request<{ chat: Session }>("POST", `/v1/chats/${id}/members`, { members }).then((r) => r.chat),
  send: (id: string, text: string) =>
    request<{ turns: Turn[] }>("POST", `/v1/chats/${id}/messages`, { text }).then(
      (r) => r.turns || [],
    ),
  cancel: (id: string) => request("POST", `/v1/chats/${id}/cancel`),
  settings: () => request<SettingsView>("GET", "/v1/settings"),
  setProvider: (name: string, p: Record<string, unknown>) =>
    request<SettingsView>("PUT", `/v1/settings/providers/${name}`, p),
  removeProvider: (name: string) =>
    request<SettingsView>("DELETE", `/v1/settings/providers/${name}`),
  testProvider: (name: string) =>
    request<{ ok: boolean; reply?: string; error?: string }>(
      "POST",
      `/v1/settings/providers/${name}/test`,
    ),
  // providerModels checks an API key that is not saved yet and lists the models it can use.
  providerModels: (name: string, p: Record<string, unknown>) =>
    request<{ ok: boolean; models?: string[]; invalid_key?: boolean; error?: string }>(
      "POST",
      "/v1/settings/provider-models",
      { name, ...p },
    ),
  testConnector: (name: string) =>
    request<ConnectorTest>("POST", `/v1/settings/connectors/${name}/test`),
  startLogin: (kind: string, project?: string) =>
    request<LoginFlow>("POST", `/v1/settings/accounts/${kind}/login`, project ? { project } : {}),
  loginFlow: (id: string) => request<LoginFlow>("GET", `/v1/settings/logins/${id}`),
  pasteLogin: (id: string, code: string) =>
    request<LoginFlow>("POST", `/v1/settings/logins/${id}/paste`, { code }),
  cancelLogin: (id: string) => request("DELETE", `/v1/settings/logins/${id}`),
  signOut: (kind: string) => request<SettingsView>("DELETE", `/v1/settings/accounts/${kind}`),
  setDefaultProvider: (name: string) =>
    request<SettingsView>("PUT", "/v1/settings/default-provider", { name }),
  // signingIn saves a connection that signs in before its sign-in, so without an account yet.
  setConnector: (name: string, c: Record<string, unknown>, signingIn = false) =>
    request<SettingsView>(
      "PUT",
      `/v1/settings/connectors/${name}${signingIn ? "?sign_in=1" : ""}`,
      c,
    ),
  removeConnector: (name: string) =>
    request<SettingsView>("DELETE", `/v1/settings/connectors/${name}`),
  skills: () => request<{ skills: Skill[] }>("GET", "/v1/skills").then((r) => r.skills || []),
  skill: (name: string) =>
    request<{ skill: Skill }>("GET", `/v1/skills/${name}`).then((r) => r.skill),
  saveSkill: (name: string, body: string) =>
    request<{ skill: Skill }>("PUT", `/v1/skills/${name}`, { body }).then((r) => r.skill),
  deleteSkill: (name: string) => request("DELETE", `/v1/skills/${name}`),
  acceptSkill: (name: string) =>
    request<{ skill: Skill }>("POST", `/v1/skills/${name}/accept`).then((r) => r.skill),
  artifacts: () =>
    request<{ artifacts: ArtifactInfo[] }>("GET", "/v1/artifacts").then((r) => r.artifacts || []),
  deleteArtifact: (name: string) => request("DELETE", `/v1/artifacts/${encodeURIComponent(name)}`),
  goals: (kitty?: string) =>
    request<{ goals: Goal[] }>(
      "GET",
      "/v1/goals" + (kitty ? "?kitty=" + encodeURIComponent(kitty) : ""),
    ).then((r) => r.goals || []),
  addGoal: (g: {
    kitty: string;
    title: string;
    text?: string;
    every?: string;
    on?: string[];
    enabled?: boolean;
  }) => request<{ goal: Goal }>("POST", "/v1/goals", g).then((r) => r.goal),
  updateGoal: (
    id: string,
    g: { title: string; text?: string; every?: string; on?: string[]; enabled?: boolean },
  ) => request<{ goal: Goal }>("PUT", `/v1/goals/${id}`, g).then((r) => r.goal),
  removeGoal: (id: string) => request("DELETE", `/v1/goals/${id}`),
  runGoal: (id: string) =>
    request<{ ok: boolean; chat: string }>("POST", `/v1/goals/${id}/run`).then((r) => r.chat),
  approvals: (status = "") =>
    request<{ approvals: Approval[] }>(
      "GET",
      "/v1/approvals" + (status ? "?status=" + status : ""),
    ).then((r) => r.approvals || []),
  approve: (id: string, always = false) =>
    request<{ approval: Approval }>("POST", `/v1/approvals/${id}/approve`, { always }).then(
      (r) => r.approval,
    ),
  reject: (id: string, reason = "") =>
    request<{ approval: Approval }>("POST", `/v1/approvals/${id}/reject`, { reason }).then(
      (r) => r.approval,
    ),
  approvalRules: () =>
    request<{ rules: ApprovalRule[] }>("GET", "/v1/approvals/rules").then((r) => r.rules || []),
  removeRule: (id: string) => request("DELETE", `/v1/approvals/rules/${id}`),
  // setRule limits an action of a kitty (all of the connection's with an empty action).
  setRule: (
    kitty: string,
    connector: string,
    action: string,
    mode: "ask" | "never" | "auto" | "",
  ) =>
    request<{ rule: ApprovalRule }>("POST", "/v1/approvals/rules", {
      kitty,
      connector,
      action,
      mode,
    }),
  memory: (kitty: string) => request<MemoryView>("GET", `/v1/kitties/${kitty}/memory`),
  remember: (kitty: string, text: string, scope = "user") =>
    request<{ note: MemoryNote }>("POST", `/v1/kitties/${kitty}/memory`, { text, scope }).then(
      (r) => r.note,
    ),
  forgetNote: (kitty: string, id: string) => request("DELETE", `/v1/kitties/${kitty}/memory/${id}`),
  setProfile: (kitty: string, demand: number, auto: boolean) =>
    request<{ profile: MemoryProfile }>("PUT", `/v1/kitties/${kitty}/memory/profile`, {
      demand,
      auto,
    }).then((r) => r.profile),
  distill: (kitty: string) =>
    request<{ notes: MemoryNote[] }>("POST", `/v1/kitties/${kitty}/memory/distill`).then(
      (r) => r.notes,
    ),
  feedback: (chat: string, index: number, rating: "up" | "down" | "", note = "") =>
    request("POST", `/v1/chats/${chat}/turns/${index}/feedback`, { rating, note }),
  setNotify: (c: { connector: string; on: string[]; digest?: string }) =>
    request<SettingsView>("PUT", "/v1/settings/notify", c),
  testNotify: (connector = "") =>
    request<{ ok: boolean; error?: string }>("POST", "/v1/settings/notify/test", { connector }),
  // The browser session of a gateway served on a network: who is signed in, and the way in and out.
  session: () =>
    request<{ signed_in: boolean; local_token: boolean; logout_url?: string }>(
      "GET",
      "/v1/session",
    ),
  login: (token: string) => request<{ ok: boolean }>("POST", "/v1/login", { token: token.trim() }),
  logout: () => request<{ ok: boolean }>("POST", "/v1/logout"),
  sendDigest: () => request<{ ok: boolean; error?: string }>("POST", "/v1/settings/notify/digest"),
  journal: (kitty: string, n = 50) =>
    request<{ journal: JournalEntry[] }>("GET", `/v1/kitties/${kitty}/journal?n=${n}`).then(
      (r) => r.journal || [],
    ),
};

// oauthStart asks the gateway for the consent URL of a connector's sign-in.
export const oauthStart = (name: string) =>
  request<{ url: string }>("POST", `/v1/oauth/${name}/start`).then((r) => r.url);

// openExternal opens a URL in the person's browser: through Wails when inside it.
export function openExternal(url: string): void {
  const android = androidBridge();
  if (android) {
    android.open(url);
    return;
  }
  const rt = (window as unknown as { runtime?: { BrowserOpenURL?: (u: string) => void } }).runtime;
  if (rt?.BrowserOpenURL) {
    rt.BrowserOpenURL(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

// watchDesktop follows a kitty's display live inside Wails, where the page cannot load the
// gateway's stream itself: each picture comes as a data: URL. It returns the function that stops
// watching, or null outside Wails (there an <img> loads streamURL).
export function watchDesktop(
  ref: string,
  onFrame: (src: string) => void,
  onError: (why: string) => void,
): (() => void) | null {
  const app = window.go?.main?.App as unknown as
    | {
        WatchDesktop?: (ref: string) => Promise<void>;
        UnwatchDesktop?: (ref: string) => Promise<void>;
      }
    | undefined;
  const rt = (
    window as unknown as {
      runtime?: { EventsOn?: (name: string, cb: (data: unknown) => void) => () => void };
    }
  ).runtime;
  if (!app?.WatchDesktop || !rt?.EventsOn) {
    return null;
  }
  const off = rt.EventsOn("kitties:desktop:" + ref, (data) => {
    const d = data as { frame?: string; error?: string };
    if (d.frame) {
      onFrame(d.frame);
    } else if (d.error) {
      onError(d.error);
    }
  });
  void app.WatchDesktop(ref).catch((e: unknown) => onError(String(e)));
  return () => {
    off();
    void app.UnwatchDesktop?.(ref);
  };
}

async function desktopResponseError(response: Response): Promise<Error> {
  const body = await response.text();
  let message = body.slice(0, 200);
  try {
    message = (JSON.parse(body) as { error?: string }).error || message;
  } catch {
    // Older gateways may return a plain-text error.
  }
  return new ApiError(response.status, message || `HTTP ${response.status}`);
}

// streamDesktop follows a kitty's display live and hands each picture to onFrame as an image
// address (a blob: URL in a browser, a data: URL inside Wails), until the returned function is
// called. The gateway's motion JPEG is read with fetch and cut into pictures here: an <img> of
// it shows nothing in some browsers (headless Chromium, Safari's webviews). onError gets why a
// stream ended or could not start; the caller falls back to screenshots.
export function streamDesktop(
  ref: string,
  onFrame: (src: string) => void,
  onError: (why: string) => void,
): () => void {
  const wails = watchDesktop(ref, onFrame, onError);
  if (wails) {
    return wails;
  }
  const stop = new AbortController();
  let last = "";
  void (async () => {
    try {
      let conn = savedConnection();
      if (!conn.token) {
        conn = await fetchLocalToken(conn);
      }
      const res = await fetch(safeGatewayBase(conn.url) + `/v1/kitties/${ref}/stream`, {
        headers: conn.token ? { Authorization: "Bearer " + conn.token } : {},
        signal: stop.signal,
      });
      if (!res.ok) throw await desktopResponseError(res);
      if (!res.body) throw new Error("the stream has no response body");
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      const text = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("the stream ended");
        }
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf);
        joined.set(value, buf.length);
        buf = joined;
        // Parts: "--boundary\r\n" or headers, a blank line, Content-Length bytes, "\r\n".
        for (;;) {
          const end = indexOf(buf, [13, 10, 13, 10]);
          if (end < 0) {
            break;
          }
          const head = text.decode(buf.subarray(0, end));
          const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? NaN);
          const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "image/jpeg";
          if (!Number.isFinite(len)) {
            throw new Error("not a picture stream");
          }
          if (buf.length < end + 4 + len) {
            break;
          }
          const picture = buf.slice(end + 4, end + 4 + len);
          buf = buf.slice(end + 4 + len);
          const src = URL.createObjectURL(new Blob([picture], { type }));
          onFrame(src);
          if (last) {
            URL.revokeObjectURL(last);
          }
          last = src;
        }
      }
    } catch (e) {
      if (!stop.signal.aborted) {
        onError(e instanceof Error ? e.message : String(e));
      }
    }
  })();
  return () => {
    stop.abort();
    if (last) {
      setTimeout(() => URL.revokeObjectURL(last), 1000);
    }
  };
}

// watchRects is rectsDesktop inside Wails: the app's WatchRects emits "kitties:rects:<ref>" events
// with the display's size and the rectangles as data: URLs, drawn here in the order they came.
function watchRects(
  ref: string,
  on: { size: (w: number, h: number) => void; rects: (list: DesktopRect[]) => void },
  onError: (why: string) => void,
): (() => void) | null {
  const app = window.go?.main?.App as unknown as
    | {
        WatchRects?: (ref: string) => Promise<void>;
        UnwatchRects?: (ref: string) => Promise<void>;
      }
    | undefined;
  const rt = (
    window as unknown as {
      runtime?: { EventsOn?: (name: string, cb: (data: unknown) => void) => () => void };
    }
  ).runtime;
  if (!app?.WatchRects || !rt?.EventsOn) {
    return null;
  }
  let ordered: Promise<unknown> = Promise.resolve();
  const off = rt.EventsOn("kitties:rects:" + ref, (data) => {
    const d = data as {
      error?: string;
      size?: [number, number];
      rects?: { x: number; y: number; w: number; h: number; data: string }[];
    };
    if (d.error) {
      onError(d.error);
    } else if (d.size) {
      const size = d.size;
      ordered = ordered.then(() => on.size(size[0], size[1]));
    } else if (d.rects) {
      const rects = d.rects;
      ordered = ordered
        .then(async () => {
          const list = await Promise.all(
            rects.map(async (r) => {
              if (!r.data.startsWith("data:image/")) {
                throw new Error("unexpected picture source");
              }
              return { ...r, blob: await (await fetch(r.data)).blob() };
            }),
          );
          on.rects(list);
        })
        .catch((e) => onError(String(e)));
    }
  });
  void app.WatchRects(ref).catch((e: unknown) => onError(String(e)));
  return () => {
    off();
    void app.UnwatchRects?.(ref);
  };
}

// A DesktopRect is a part of the display that changed, and its picture.
// DesktopInfo is what is known about a kitty's desktop: its image, whether a newer one waits, and
// when its sessions were last backed up.
export interface BackupStatus {
  enabled: boolean;
  running: boolean;
  phase?: string;
  last_success?: string;
  last_failure?: string;
  last_error?: string;
  next_attempt?: string;
  overdue: boolean;
  snapshot_id?: string;
}

export type Recovery = {
  name: string;
  computer: NonNullable<Kitty["computer"]>;
  checkpoint_name: string;
  checkpoint_at?: string;
  removed: boolean;
  pending?: string;
};

export type DesktopInfo = {
  capabilities?: {
    kind: string;
    persistent_disk: boolean;
    guest_workspace: boolean;
    image_updates: boolean;
  };
  image: string;
  update_available: boolean;
  auto_update?: boolean;
  backup?: { saved: string; bytes: number };
};

// UpdateStatus says which version of Kitties runs, whether a newer one is out, and whether this
// gateway may install it by itself (and why not when it may not).
export type UpdateStatus = {
  current: string;
  latest?: string;
  available: boolean;
  mode: "off" | "notify" | "auto";
  can_apply: boolean;
  // signed is true when releases are checked against a signing key (updates.public_key).
  signed?: boolean;
  // skipped is a newer version that was tried here and did not hold: it is not offered again.
  skipped?: string;
  why?: string;
  checked_at?: string;
  error?: string;
};

// A Secret is one of the vault: its name and the ids of the kitties that may type it.
export type Secret = { name: string; kitties: string[]; saved: string };

export type DesktopRect = { x: number; y: number; w: number; h: number; blob: Blob };

// rectsDesktop follows a kitty's display as what changed on it, like VNC: the whole picture
// first, then only the rectangles that differ from the one before (the gateway's /rects). size
// says the display's size, and rects the pictures to draw over what is there. It returns the
// function that stops it, or null where it cannot be had. Inside Wails the page cannot reach the
// gateway itself: the app reads the stream and hands each update over as runtime events. onError
// says why it ended (a gateway without /rects answers 404); the caller falls back to streamDesktop.
export function rectsDesktop(
  ref: string,
  on: { size: (w: number, h: number) => void; rects: (list: DesktopRect[]) => void },
  onError: (why: string) => void,
): (() => void) | null {
  if (window.go?.main?.App) {
    return watchRects(ref, on, onError);
  }
  const stop = new AbortController();
  void (async () => {
    try {
      let conn = savedConnection();
      if (!conn.token) {
        conn = await fetchLocalToken(conn);
      }
      const res = await fetch(safeGatewayBase(conn.url) + `/v1/kitties/${ref}/rects?fps=20`, {
        headers: conn.token ? { Authorization: "Bearer " + conn.token } : {},
        signal: stop.signal,
      });
      if (!res.ok) throw await desktopResponseError(res);
      if (!res.body) throw new Error("the stream has no response body");
      const reader = res.body.getReader();
      const text = new TextDecoder();
      let buf = new Uint8Array(0);
      // want is how many rectangles of the update are still to come; head is the one whose
      // picture is being waited for; batch is what the update has so far.
      let want = 0;
      let head: number[] | null = null;
      let batch: DesktopRect[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("the stream ended");
        }
        const joined = new Uint8Array(buf.length + value.length);
        joined.set(buf);
        joined.set(value, buf.length);
        buf = joined;
        for (;;) {
          if (head) {
            if (buf.length < head[4]) {
              break;
            }
            batch.push({
              x: head[0],
              y: head[1],
              w: head[2],
              h: head[3],
              blob: new Blob([buf.slice(0, head[4])]),
            });
            buf = buf.slice(head[4]);
            head = null;
            if (--want === 0) {
              on.rects(batch);
              batch = [];
            }
            continue;
          }
          const nl = buf.indexOf(10);
          if (nl < 0) {
            break;
          }
          const line = text.decode(buf.subarray(0, nl)).trim().split(" ");
          buf = buf.slice(nl + 1);
          if (line[0] === "SCREEN" && line.length === 3) {
            on.size(Number(line[1]), Number(line[2]));
          } else if (line[0] === "UPDATE" && line.length === 2) {
            want = Number(line[1]);
            batch = [];
          } else if (line[0] === "RECT" && line.length === 6 && want > 0) {
            head = line.slice(1).map(Number);
          } else {
            throw new Error("not a stream of rectangles");
          }
        }
      }
    } catch (e) {
      if (!stop.signal.aborted) {
        onError(e instanceof Error ? e.message : String(e));
      }
    }
  })();
  return () => stop.abort();
}

// indexOf finds a sequence of bytes, or -1.
function indexOf(buf: Uint8Array, seq: number[]): number {
  outer: for (let i = 0; i + seq.length <= buf.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

// watchChat follows a chat's events as they happen. In a browser it is an EventSource on the
// gateway; inside Wails the Go side reads the stream and emits runtime events. It returns the
// function that stops watching.
export function watchChat(id: string, onEvent: (e: ChatEvent) => void): () => void {
  const app = window.go?.main?.App;
  const rt = (
    window as unknown as {
      runtime?: { EventsOn?: (name: string, cb: (data: unknown) => void) => () => void };
    }
  ).runtime;
  if (app && (app as unknown as { Watch?: (id: string) => Promise<void> }).Watch && rt?.EventsOn) {
    const off = rt.EventsOn("kitties:chat:" + id, (data) => onEvent(data as ChatEvent));
    void (app as unknown as { Watch: (id: string) => Promise<void> }).Watch(id);
    return () => {
      off();
      void (app as unknown as { Unwatch?: (id: string) => Promise<void> }).Unwatch?.(id);
    };
  }
  if (typeof EventSource === "undefined") {
    return () => {};
  }
  // The stream carries the token in its address: on a first visit the token is fetched first,
  // or the stream is refused and nothing arrives live until a reload.
  let es: EventSource | null = null;
  let closed = false;
  const conn = savedConnection();
  void (conn.token ? Promise.resolve(conn) : fetchLocalToken(conn)).then(() => {
    if (closed) {
      return;
    }
    es = new EventSource(shotURL(`/v1/chats/${id}/events`));
    for (const type of ["turn", "update", "done", "deleted"]) {
      es.addEventListener(type, (ev) => {
        try {
          onEvent(JSON.parse((ev as MessageEvent).data) as ChatEvent);
        } catch {
          /* a malformed event is dropped */
        }
      });
    }
  });
  return () => {
    closed = true;
    es?.close();
  };
}

// artifactText loads a text artifact for reading in the page.
export async function artifactText(name: string): Promise<string> {
  const app = window.go?.main?.App;
  const path = `/v1/artifacts/${encodeURIComponent(name)}`;
  if (app) {
    const raw = await app.Request("GET", path, "");
    const parsed = JSON.parse(raw) as { status: number; body: string; base64?: string };
    if (parsed.status >= 400) {
      throw new ApiError(parsed.status, "no artifact");
    }
    return parsed.base64 ? "(binary file)" : parsed.body;
  }
  const res = await fetch(shotURL(path));
  if (!res.ok) {
    throw new ApiError(res.status, "no artifact");
  }
  return res.text();
}
