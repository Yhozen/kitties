import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { ChatgptAccount, ChatgptLink, ChatgptFailure } from "@kitties/domain/entities";
import { chatgptConfig as config, loopbackRedirect } from "./chatgpt-config.ts";
import {
  ChatgptProviderError,
  chatgptError,
  chatgptFailure,
  safeChatgptError,
} from "./chatgpt-errors.ts";
import { completedResponse } from "./chatgpt-stream.ts";
import { randomSecret, pkceChallenge, jsonResponse, type OAuthStorage } from "./oauth-core.ts";
import { allowedFetch } from "./outbound.ts";
import { seal, open, type Envelope } from "./secrets.ts";

type Storage = OAuthStorage & { list(kind: string): { id: string; body: string }[] };
export interface ChatgptContext {
  hostId: string;
  epoch: number;
}
interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
  earliestRefreshAt?: number;
}
interface AccountRow {
  account: ChatgptAccount;
  revision: string;
  epoch: number;
  credentials?: Envelope;
  refreshing?: boolean;
}
interface Flow {
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  clientId: string;
  subject?: string;
  requestConsent: boolean;
}
interface LinkRow {
  view: ChatgptLink;
  epoch: number;
  envelope?: Envelope;
  issuedClientId?: string;
}
export interface ChatgptCallback {
  state: string;
  code?: string;
  clientId?: string;
  issuer?: string;
  error?: string;
}
const authFetch = (url: string, init?: RequestInit) =>
  allowedFetch(url, ["auth.openai.com"], {
    ...init,
    signal: AbortSignal.timeout(30000),
  });
const keys = createRemoteJWKSet(new URL(config.jwksUri), {
  [customFetch]: (url, init) => authFetch(String(url), init),
});
export async function verifyChatgptIdentity(token: string, clientId: string, nonce: string) {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "nonce"],
      clockTolerance: 5,
    });
    if (
      payload.nonce !== nonce ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 512 ||
      typeof payload.iat !== "number" ||
      payload.iat > Date.now() / 1000 + 5 ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
    )
      chatgptError("CHATGPT_IDENTITY_INVALID");
    return {
      subject: payload.sub,
      ...(typeof payload.email === "string" && payload.email.length <= 320
        ? { email: payload.email }
        : {}),
    };
  } catch {
    return chatgptError("CHATGPT_IDENTITY_INVALID");
  }
}
const terminalRefresh = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
function parseTokens(raw: Record<string, unknown>, previous?: Tokens): Tokens {
  const valid = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 32768;
  const refreshToken = raw.refresh_token,
    idToken = raw.id_token ?? previous?.idToken;
  if (
    !valid(raw.access_token) ||
    !valid(refreshToken) ||
    !valid(idToken) ||
    typeof raw.token_type !== "string" ||
    raw.token_type.toLowerCase() !== "bearer" ||
    typeof raw.expires_in !== "number" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in <= 0 ||
    (raw.scope !== undefined && (typeof raw.scope !== "string" || raw.scope.length > 4096)) ||
    (!previous && typeof raw.scope !== "string")
  )
    chatgptError("CHATGPT_INVALID_TOKEN_RESPONSE");
  // earliest_refresh_at is a Unix timestamp in seconds when supplied.
  const earliest = raw.earliest_refresh_at;
  if (
    earliest !== undefined &&
    (typeof earliest !== "number" || !Number.isFinite(earliest) || earliest < 0)
  )
    chatgptError("CHATGPT_INVALID_TOKEN_RESPONSE");
  return {
    accessToken: raw.access_token,
    refreshToken,
    idToken,
    expiresAt: Date.now() + raw.expires_in * 1000,
    scopes:
      typeof raw.scope === "string" ? raw.scope.split(/\s+/).filter(Boolean) : previous!.scopes,
    ...(typeof earliest === "number" ? { earliestRefreshAt: earliest * 1000 } : {}),
  };
}
async function exchange(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await authFetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  let raw: Record<string, unknown>;
  try {
    raw = await jsonResponse(new Response(response.body, { status: 200 }));
  } catch (error) {
    if (response.ok) throw error;
    raw = {};
  }
  if (!response.ok) {
    const code = typeof raw.error === "string" ? raw.error : undefined;
    const info = chatgptFailure(
      response.status,
      typeof raw.error === "string" ? { error: { code } } : raw,
      response.headers.get("openai-request-id") ??
        response.headers.get("x-request-id") ??
        undefined,
    );
    throw new ChatgptProviderError(info);
  }
  return raw;
}

// All credential handling and network calls live in HomeDO, outside workflow journals.
export function makeChatgptStorage(
  storage: Storage,
  kek: string,
  context: () => Promise<ChatgptContext>,
) {
  type Access = { accessToken: string; revision: string; epoch: number };
  const refreshing = new Map<string, Promise<Access>>();
  const get = <T>(kind: string, id: string): T | undefined => {
    const raw = storage.get(kind, id);
    return raw ? (JSON.parse(raw) as T) : undefined;
  };
  const put = (kind: string, id: string, value: unknown) =>
    storage.put(kind, id, JSON.stringify(value));
  const aad = (id: string) => `chatgpt:${id}:credentials`;
  const guard = async (epoch: number) => {
    if ((await context()).epoch !== epoch) chatgptError("CHATGPT_RECOVERY_FENCED");
  };
  const save = (id: string, row: AccountRow) => put("chatgpt-account", id, row);
  const readAccount = (id: string, epoch: number): AccountRow => {
    const row = get<AccountRow>("chatgpt-account", id);
    if (!row) chatgptError("CHATGPT_ACCOUNT_NOT_FOUND");
    if (row.epoch !== epoch) {
      row.epoch = epoch;
      row.revision = randomSecret();
      delete row.credentials;
      delete row.refreshing;
      row.account = {
        ...row.account,
        status: "reauthorize",
        admittedAt: undefined,
        updatedAt: Date.now(),
      };
      storage.take("chatgpt-active-link", id);
      save(id, row);
    }
    return row;
  };
  const credentials = async (id: string, row: AccountRow): Promise<Tokens> => {
    if (!row.credentials) chatgptError("CHATGPT_REAUTHORIZE_REQUIRED");
    return JSON.parse(await open(kek, aad(id), row.credentials)) as Tokens;
  };
  const checkRevision = (id: string, revision: string) => {
    if (get<AccountRow>("chatgpt-account", id)?.revision !== revision)
      chatgptError("CHATGPT_REVISION_CHANGED");
  };
  const readLink = (id: string, epoch: number): LinkRow => {
    const row = get<LinkRow>("chatgpt-link", id);
    if (!row) chatgptError("CHATGPT_LINK_NOT_FOUND");
    if (
      (row.view.status === "pending" || row.view.status === "exchanging") &&
      (row.epoch !== epoch || row.view.expiresAt <= Date.now())
    ) {
      row.view = { ...row.view, status: "expired" };
      delete row.envelope;
      put("chatgpt-link", id, row);
    }
    return row;
  };
  const ensureLink = (id: string, epoch: number) => {
    const row = readLink(id, epoch);
    if (
      !["pending", "exchanging"].includes(row.view.status) ||
      storage.get("chatgpt-active-link", row.view.accountId!) !== id
    )
      chatgptError("CHATGPT_LINK_EXPIRED");
    return row;
  };
  const markError = async (id: string, epoch: number, revision: string, error: ChatgptFailure) => {
    await guard(epoch);
    checkRevision(id, revision);
    const row = readAccount(id, epoch);
    row.account = { ...row.account, lastError: error, updatedAt: Date.now() };
    save(id, row);
  };
  const token = async (id: string): Promise<Access> => {
    const { epoch } = await context(),
      row = readAccount(id, epoch);
    if (row.account.status === "consent_required")
      chatgptError("CHATGPT_CONSENT_REQUIRED", "consent_required");
    if (row.account.status !== "connected") chatgptError("CHATGPT_REAUTHORIZE_REQUIRED");
    if (refreshing.has(id)) return refreshing.get(id)!;
    if (row.refreshing) {
      delete row.credentials;
      delete row.refreshing;
      row.revision = randomSecret();
      row.account = {
        ...row.account,
        status: "reauthorize",
        admittedAt: undefined,
        updatedAt: Date.now(),
      };
      save(id, row);
      chatgptError("CHATGPT_REFRESH_OUTCOME_UNKNOWN");
    }
    const pending = (async () => {
      const old = await credentials(id, row);
      await guard(epoch);
      checkRevision(id, row.revision);
      if (old.expiresAt > Date.now() + 60000)
        return { accessToken: old.accessToken, revision: row.revision, epoch };
      if (old.earliestRefreshAt && old.earliestRefreshAt > Date.now())
        chatgptError("CHATGPT_REFRESH_NOT_YET_ALLOWED", "provider_unavailable");
      // Persist before sending a rotating refresh. On eviction this is never retried.
      row.refreshing = true;
      save(id, row);
      let received = false;
      try {
        const result = await exchange(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: row.account.clientId,
            refresh_token: old.refreshToken,
            resource: config.resource,
          }),
        );
        received = true;
        const next = parseTokens(result, old),
          envelope = await seal(kek, aad(id), JSON.stringify(next));
        await guard(epoch);
        checkRevision(id, row.revision);
        delete row.refreshing;
        row.credentials = envelope;
        row.revision = randomSecret();
        row.account = {
          ...row.account,
          status: next.scopes.includes("chatgpt.tokens.use.direct")
            ? "connected"
            : "consent_required",
          lastError: undefined,
          updatedAt: Date.now(),
        };
        save(id, row);
        return { accessToken: next.accessToken, revision: row.revision, epoch };
      } catch (error) {
        await guard(epoch);
        checkRevision(id, row.revision);
        const info = safeChatgptError(error);
        // An explicit provider rejection did not rotate. Network loss or an invalid
        // successful response has an uncertain outcome and requires reauthorization.
        const explicit = error instanceof ChatgptProviderError && info.status !== undefined;
        if (!explicit || received || terminalRefresh.has(info.code)) {
          delete row.credentials;
          row.account = { ...row.account, status: "reauthorize", admittedAt: undefined };
        }
        delete row.refreshing;
        row.revision = randomSecret();
        row.account = { ...row.account, lastError: info, updatedAt: Date.now() };
        save(id, row);
        throw new ChatgptProviderError(info);
      }
    })();
    refreshing.set(id, pending);
    try {
      return await pending;
    } finally {
      if (refreshing.get(id) === pending) refreshing.delete(id);
    }
  };
  const api = async (id: string, path: "/models" | "/responses", init?: RequestInit) => {
    const access = await token(id),
      { epoch } = await context(),
      row = readAccount(id, epoch),
      revision = row.revision;
    // Bind the bearer to the exact record/epoch that returned it, including across
    // disconnect followed by reconnect while the external recovery check yielded.
    if (access.epoch !== epoch) chatgptError("CHATGPT_RECOVERY_FENCED");
    checkRevision(id, access.revision);
    if (row.account.status === "consent_required")
      chatgptError("CHATGPT_CONSENT_REQUIRED", "consent_required");
    if (row.account.status !== "connected" || !row.credentials)
      chatgptError("CHATGPT_REAUTHORIZE_REQUIRED");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${access.accessToken}`);
    const response = await allowedFetch(config.resource + path, ["api.openai.com"], {
      ...init,
      headers,
      signal: AbortSignal.timeout(90000),
    });
    await guard(epoch);
    checkRevision(id, revision);
    if (!response.ok) {
      let body: unknown;
      try {
        body = await jsonResponse(new Response(response.body, { status: 200 }));
      } catch {
        body = {};
      }
      const info = chatgptFailure(
        response.status,
        body,
        response.headers.get("openai-request-id") ??
          response.headers.get("x-request-id") ??
          undefined,
      );
      await markError(id, epoch, revision, info);
      throw new ChatgptProviderError(info);
    }
    return { response, epoch, revision };
  };
  const models = async (id: string) => {
    const { response, epoch, revision } = await api(id, "/models");
    const body = await jsonResponse(response);
    if (!Array.isArray(body.models) || body.models.length > 1000)
      chatgptError("CHATGPT_INVALID_CATALOG", "unsupported_request");
    const result: { slug: string; displayName: string }[] = [];
    for (const model of body.models) {
      if (!model || typeof model !== "object" || model.visibility !== "list") continue;
      if (
        typeof model.slug !== "string" ||
        !model.slug ||
        model.slug.length > 200 ||
        typeof model.display_name !== "string" ||
        model.display_name.length > 200
      )
        chatgptError("CHATGPT_INVALID_CATALOG", "unsupported_request");
      result.push({ slug: model.slug, displayName: model.display_name });
    }
    await guard(epoch);
    checkRevision(id, revision);
    return result;
  };
  return {
    accounts: async () => {
      const { epoch } = await context();
      return storage.list("chatgpt-account").map(({ id }) => readAccount(id, epoch).account);
    },
    account: async (id: string) => readAccount(id, (await context()).epoch).account,
    begin: async (input: {
      redirectUri: string;
      accountId?: string;
      retryAttemptId?: string;
      requestConsent?: boolean;
    }): Promise<ChatgptLink> => {
      const redirectUri = (() => {
          try {
            return loopbackRedirect(input.redirectUri);
          } catch {
            return chatgptError("CHATGPT_INVALID_CALLBACK", "unsupported_request");
          }
        })(),
        { epoch, hostId } = await context();
      if (input.accountId && input.retryAttemptId)
        chatgptError("CHATGPT_INVALID_LINK", "unsupported_request");
      const retry = input.retryAttemptId ? readLink(input.retryAttemptId, epoch) : undefined;
      if (
        retry &&
        (retry.epoch !== epoch || retry.view.status !== "failed" || !retry.issuedClientId)
      )
        chatgptError("CHATGPT_LINK_EXPIRED");
      const selectedId =
        input.accountId ??
        (retry && get<AccountRow>("chatgpt-account", retry.view.accountId!)
          ? retry.view.accountId
          : undefined);
      const selected = selectedId ? readAccount(selectedId, epoch) : undefined;
      // Clean old public attempt records and state mappings; cap outstanding work.
      let pendingCount = 0;
      for (const item of storage.list("chatgpt-link")) {
        const link = readLink(item.id, epoch);
        if (link.view.status === "pending" || link.view.status === "exchanging") pendingCount++;
        else {
          if (storage.get("chatgpt-active-link", link.view.accountId!) === item.id)
            storage.take("chatgpt-active-link", link.view.accountId!);
          storage.take("chatgpt-link", item.id);
        }
      }
      for (const item of storage.list("chatgpt-state"))
        if (!get<LinkRow>("chatgpt-link", item.body)) storage.take("chatgpt-state", item.id);
      if (pendingCount >= 16) chatgptError("CHATGPT_LINK_LIMIT", "unsupported_request");
      const id = crypto.randomUUID(),
        accountId = selectedId ?? retry?.view.accountId ?? crypto.randomUUID();
      const flow: Flow = {
        state: randomSecret(),
        nonce: randomSecret(),
        verifier: randomSecret(),
        redirectUri,
        clientId: selected?.account.clientId ?? retry?.issuedClientId ?? config.clientId,
        subject: selected?.account.subject,
        requestConsent: input.requestConsent === true,
      };
      const envelope = await seal(kek, `chatgpt-link:${id}`, JSON.stringify({ ...flow, hostId }));
      await guard(epoch);
      if (selected) checkRevision(accountId, selected.revision);
      const view: ChatgptLink = {
        id,
        accountId,
        status: "pending",
        expiresAt: Date.now() + 600000,
      };
      put("chatgpt-link", id, { view, epoch, envelope });
      storage.put("chatgpt-state", flow.state, id);
      storage.put("chatgpt-active-link", accountId, id);
      return view;
    },
    attempt: async (id: string) => readLink(id, (await context()).epoch).view,
    authorize: async (id: string) => {
      const { epoch, hostId } = await context(),
        link = ensureLink(id, epoch);
      if (link.view.status !== "pending" || !link.envelope) chatgptError("CHATGPT_LINK_EXPIRED");
      const flow = JSON.parse(await open(kek, `chatgpt-link:${id}`, link.envelope)) as Flow;
      const url = new URL(config.authorizationEndpoint);
      const params: Record<string, string> = {
        client_id: flow.clientId,
        ext_agent_host_id: hostId,
        response_type: "code",
        redirect_uri: flow.redirectUri,
        scope: config.scope,
        resource: config.resource,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge_method: "S256",
        code_challenge: await pkceChallenge(flow.verifier),
      };
      if (flow.clientId === config.clientId) params.agent_name_hint = "Kitties";
      else if (get<AccountRow>("chatgpt-account", link.view.accountId!)) {
        const row = readAccount(link.view.accountId!, epoch);
        // A retained ID token goes only into a server redirect to OpenAI.
        if (row.credentials)
          params.id_token_hint = (await credentials(link.view.accountId!, row)).idToken;
        if (row.account.email) params.login_hint = row.account.email;
      }
      if (flow.requestConsent) params.prompt = "consent";
      await guard(epoch);
      ensureLink(id, epoch);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url.href;
    },
    cancel: async (id: string) => {
      const { epoch } = await context(),
        link = readLink(id, epoch);
      if (link.view.status === "pending" || link.view.status === "exchanging") {
        link.view = { ...link.view, status: "cancelled" };
        delete link.envelope;
        put("chatgpt-link", id, link);
        if (storage.get("chatgpt-active-link", link.view.accountId!) === id)
          storage.take("chatgpt-active-link", link.view.accountId!);
      }
      return link.view;
    },
    finish: async (callback: ChatgptCallback) => {
      const { epoch, hostId } = await context();
      const id = storage.take("chatgpt-state", callback.state);
      if (!id) chatgptError("CHATGPT_STATE_USED");
      const link = ensureLink(id, epoch);
      if (link.view.status !== "pending" || !link.envelope) chatgptError("CHATGPT_STATE_USED");
      const originalEnvelope = link.envelope;
      link.view = { ...link.view, status: "exchanging" };
      delete link.envelope;
      put("chatgpt-link", id, link);
      try {
        const flow = JSON.parse(await open(kek, `chatgpt-link:${id}`, originalEnvelope)) as Flow;
        if (flow.state !== callback.state || (callback.issuer && callback.issuer !== config.issuer))
          chatgptError("CHATGPT_STATE_INVALID");
        if (callback.error) {
          link.view = { ...link.view, status: "denied" };
          put("chatgpt-link", id, link);
          return link.view;
        }
        const clientId = callback.clientId ?? flow.clientId;
        if (
          !/^oaiapp_[a-zA-Z0-9_-]{1,200}$/.test(clientId) ||
          (flow.clientId !== config.clientId && flow.clientId !== clientId)
        )
          chatgptError("CHATGPT_CLIENT_MISMATCH");
        if (!callback.code || callback.code.length > 8192) chatgptError("CHATGPT_CODE_REQUIRED");
        // Retain the issued registration even when code exchange fails. It is diagnostic
        // pending state, not a verified account and cannot replace selected credentials.
        link.issuedClientId = clientId;
        put("chatgpt-link", id, link);
        await guard(epoch);
        ensureLink(id, epoch);
        const raw = await exchange(
          new URLSearchParams({
            grant_type: "authorization_code",
            code: callback.code,
            client_id: clientId,
            code_verifier: flow.verifier,
            redirect_uri: flow.redirectUri,
            resource: config.resource,
          }),
        );
        const tokens = parseTokens(raw),
          identity = await verifyChatgptIdentity(tokens.idToken, clientId, flow.nonce);
        if (flow.subject && flow.subject !== identity.subject)
          chatgptError("CHATGPT_ACCOUNT_MISMATCH");
        for (const existing of storage.list("chatgpt-account")) {
          const other = JSON.parse(existing.body) as AccountRow;
          if (existing.id !== link.view.accountId && other.account.clientId === clientId)
            chatgptError("CHATGPT_REGISTRATION_EXISTS");
        }
        const accountId = link.view.accountId!,
          envelope = await seal(kek, aad(accountId), JSON.stringify(tokens));
        await guard(epoch);
        ensureLink(id, epoch);
        const account: ChatgptAccount = {
          id: accountId,
          label: `${identity.email ?? "ChatGPT"} · ${clientId.slice(-8)}`,
          clientId,
          issuer: config.issuer,
          ...identity,
          hostId,
          status: tokens.scopes.includes("chatgpt.tokens.use.direct")
            ? "connected"
            : "consent_required",
          updatedAt: Date.now(),
        };
        save(accountId, { account, revision: randomSecret(), epoch, credentials: envelope });
        link.view = { ...link.view, status: "connected" };
        put("chatgpt-link", id, link);
        storage.take("chatgpt-active-link", accountId);
        return link.view;
      } catch (error) {
        await guard(epoch);
        const current = readLink(id, epoch);
        if (current.view.status === "exchanging") {
          current.view = {
            ...current.view,
            status: "failed",
            error: safeChatgptError(error),
            canRetryRegistration: !!current.issuedClientId,
          };
          put("chatgpt-link", id, current);
        }
        throw new ChatgptProviderError(safeChatgptError(error));
      }
    },
    disconnect: async (id: string) => {
      const { epoch } = await context(),
        row = readAccount(id, epoch),
        old = row.credentials,
        wasRefreshing = row.refreshing;
      storage.take("chatgpt-active-link", id);
      delete row.credentials;
      delete row.refreshing;
      row.revision = randomSecret();
      row.account = {
        ...row.account,
        status: "disconnected",
        admittedAt: undefined,
        lastError: undefined,
        updatedAt: Date.now(),
      };
      save(id, row);
      if (!old) return { revocationConfirmed: false };
      try {
        const tokens = JSON.parse(await open(kek, aad(id), old)) as Tokens;
        const metadata = await jsonResponse(await authFetch(config.discoveryUri));
        if (
          metadata.issuer !== config.issuer ||
          typeof metadata.revocation_endpoint !== "string" ||
          new URL(metadata.revocation_endpoint).origin !== config.issuer
        )
          return { revocationConfirmed: false };
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await authFetch(metadata.revocation_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: tokens.refreshToken,
              token_type_hint: "refresh_token",
              client_id: row.account.clientId,
            }),
          });
          if (response.status === 200) return { revocationConfirmed: !wasRefreshing };
          if (response.status < 500) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch {
        /* Local disconnect stays effective even when remote revocation fails. */
      }
      return { revocationConfirmed: false };
    },
    models,
    probe: async (id: string) => {
      try {
        const catalog = await models(id),
          model = catalog[0]?.slug;
        if (!model) chatgptError("CHATGPT_NO_MODELS", "account_ineligible");
        const { response, epoch, revision } = await api(id, "/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            input: [{ role: "user", content: "Say exactly: Hello, world!" }],
            store: false,
            stream: true,
          }),
        });
        try {
          await completedResponse(response);
        } catch (error) {
          await markError(id, epoch, revision, safeChatgptError(error));
          throw error;
        }
        await guard(epoch);
        checkRevision(id, revision);
        const row = readAccount(id, epoch),
          completedAt = Date.now();
        row.account = {
          ...row.account,
          admittedAt: completedAt,
          lastError: undefined,
          updatedAt: completedAt,
        };
        save(id, row);
        return { ok: true, model, completedAt };
      } catch (error) {
        return { ok: false, error: safeChatgptError(error) };
      }
    },
    invalidate: () => {
      for (const { id, body } of storage.list("chatgpt-account")) {
        const row = JSON.parse(body) as AccountRow;
        delete row.credentials;
        delete row.refreshing;
        row.revision = randomSecret();
        row.account = {
          ...row.account,
          status: "reauthorize",
          admittedAt: undefined,
          updatedAt: Date.now(),
        };
        save(id, row);
      }
      for (const kind of ["chatgpt-link", "chatgpt-state", "chatgpt-active-link"])
        for (const { id } of storage.list(kind)) storage.take(kind, id);
    },
  };
}
