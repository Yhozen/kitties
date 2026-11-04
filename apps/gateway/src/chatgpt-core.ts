import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { ChatgptAccountView, ChatgptLinkView } from "@kitties/domain/entities";
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

export type ChatgptStorageInput = OAuthStorage & {
  list(kind: string): { id: string; body: string }[];
};

export interface ChatgptContext {
  hostId: string;
  epoch: number;
}

interface ChatgptIdentity {
  subject: string;
  email?: string;
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

const tokenText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32768));

const TokenResponse = Schema.Struct({
  access_token: tokenText,
  refresh_token: tokenText,
  id_token: Schema.optional(Schema.NullOr(tokenText)),
  token_type: Schema.String,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  scope: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  earliest_refresh_at: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TokenRecord = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  idToken: Schema.String,
  expiresAt: Schema.Number,
  scopes: Schema.mutable(Schema.Array(Schema.String)),
  earliestRefreshAt: Schema.optional(Schema.Number),
});

const EnvelopeRecord = Schema.Struct({ kid: Schema.String, iv: Schema.String, ct: Schema.String });

const AccountRecord = Schema.Struct({
  account: ChatgptAccountView,
  revision: Schema.String,
  epoch: Schema.Number,
  credentials: Schema.optional(EnvelopeRecord),
  refreshing: Schema.optional(Schema.Boolean),
});

const LinkRecord = Schema.Struct({
  view: ChatgptLinkView,
  epoch: Schema.Number,
  envelope: Schema.optional(EnvelopeRecord),
  issuedClientId: Schema.optional(Schema.String),
});

const FlowRecord = Schema.Struct({
  state: Schema.String,
  verifier: Schema.String,
  nonce: Schema.String,
  redirectUri: Schema.String,
  clientId: Schema.String,
  subject: Schema.optional(Schema.String),
  requestConsent: Schema.Boolean,
});

const IdentityClaims = Schema.Struct({
  sub: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  iat: Schema.Number,
  nonce: Schema.String,
  aud: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Json)])),
  azp: Schema.optional(Schema.Unknown),
  email: Schema.optional(Schema.Unknown),
});

const identityEmail = Schema.String.check(Schema.isMaxLength(320));

const Catalog = Schema.Struct({
  models: Schema.Array(Schema.Json).check(Schema.isMaxLength(1000)),
});

const ListedModel = Schema.Struct({ visibility: Schema.Literal("list") });

const CatalogModel = Schema.Struct({
  slug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  display_name: Schema.String.check(Schema.isMaxLength(200)),
});

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

    const identity = Schema.decodeUnknownSync(IdentityClaims)(payload);

    if (
      identity.nonce !== nonce ||
      identity.iat > Date.now() / 1000 + 5 ||
      (Array.isArray(identity.aud) && identity.aud.length > 1 && identity.azp !== clientId)
    )
      chatgptError("CHATGPT_IDENTITY_INVALID");

    const result: ChatgptIdentity = { subject: identity.sub };
    const email = Schema.decodeUnknownOption(identityEmail)(identity.email);

    if (Option.isSome(email)) result.email = email.value;

    return result;
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

function parseTokens(input: Schema.JsonObject, previous?: Tokens): Tokens {
  const decoded = Schema.decodeUnknownOption(TokenResponse)(input);

  if (Option.isNone(decoded)) chatgptError("CHATGPT_INVALID_TOKEN_RESPONSE");
  const raw = decoded.value;
  const idToken = raw.id_token ?? previous?.idToken;

  if (
    !idToken ||
    raw.token_type.toLowerCase() !== "bearer" ||
    (!previous && raw.scope === undefined)
  )
    chatgptError("CHATGPT_INVALID_TOKEN_RESPONSE");

  const tokens: Tokens = {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    idToken,
    expiresAt: Date.now() + raw.expires_in * 1000,
    scopes: raw.scope === undefined ? previous!.scopes : raw.scope.split(/\s+/).filter(Boolean),
  };

  // earliest_refresh_at is a Unix timestamp in seconds when supplied.
  if (raw.earliest_refresh_at !== undefined)
    tokens.earliestRefreshAt = raw.earliest_refresh_at * 1000;

  return tokens;
}

async function exchange(body: URLSearchParams): Promise<Schema.JsonObject> {
  const response = await authFetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  let raw: Schema.JsonObject;

  try {
    raw = await jsonResponse(new Response(response.body, { status: 200 }));
  } catch (error) {
    if (response.ok) throw error;
    raw = {};
  }

  if (!response.ok) {
    const code = Schema.is(Schema.String)(raw.error) ? raw.error : undefined;

    const info = chatgptFailure(
      response.status,
      Schema.is(Schema.String)(raw.error) ? { error: { code } } : raw,
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
  storage: ChatgptStorageInput,
  kek: string,
  context: () => Promise<ChatgptContext>,
) {
  type Access = { accessToken: string; revision: string; epoch: number };

  const refreshing = new Map<string, Promise<Access>>();

  const get = <A>(kind: string, id: string, schema: Schema.Codec<A>): A | undefined => {
    const raw = storage.get(kind, id);

    return raw ? Schema.decodeUnknownSync(schema)(JSON.parse(raw)) : undefined;
  };

  const put = (kind: string, id: string, value: AccountRow | LinkRow) =>
    storage.put(kind, id, JSON.stringify(value));

  const aad = (id: string) => `chatgpt:${id}:credentials`;

  const guard = async (epoch: number) => {
    if ((await context()).epoch !== epoch) chatgptError("CHATGPT_RECOVERY_FENCED");
  };

  const save = (id: string, row: AccountRow) => put("chatgpt-account", id, row);

  const readAccount = (id: string, epoch: number): AccountRow => {
    const row: AccountRow | undefined = get("chatgpt-account", id, AccountRecord);

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

    return Schema.decodeUnknownSync(TokenRecord)(
      JSON.parse(await open(kek, aad(id), row.credentials)),
    );
  };

  const checkRevision = (id: string, revision: string) => {
    if (get("chatgpt-account", id, AccountRecord)?.revision !== revision)
      chatgptError("CHATGPT_REVISION_CHANGED");
  };

  const readLink = (id: string, epoch: number): LinkRow => {
    const row: LinkRow | undefined = get("chatgpt-link", id, LinkRecord);

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
      let body: Schema.JsonObject;

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

    // Account catalogs include metadata beyond the fields we retain and can exceed
    // the smaller OAuth token-response bound. Never persist or log that metadata.
    const body = await jsonResponse(response, 4 * 1024 * 1024).catch((cause: unknown) => {
      throw new ChatgptProviderError({
        ...chatgptFailure(
          response.status,
          {},
          response.headers.get("openai-request-id") ??
            response.headers.get("x-request-id") ??
            undefined,
        ),
        reason: "unsupported_request",
        code:
          cause instanceof Error && cause.message === "OAUTH_RESPONSE_LIMIT"
            ? "CHATGPT_CATALOG_TOO_LARGE"
            : "CHATGPT_INVALID_CATALOG",
      });
    });

    const catalog = Schema.decodeUnknownOption(Catalog)(body);

    if (Option.isNone(catalog)) chatgptError("CHATGPT_INVALID_CATALOG", "unsupported_request");
    const result: { slug: string; displayName: string }[] = [];

    for (const candidate of catalog.value.models) {
      if (!Schema.is(ListedModel)(candidate)) continue;
      const model = Schema.decodeUnknownOption(CatalogModel)(candidate);

      if (Option.isNone(model)) chatgptError("CHATGPT_INVALID_CATALOG", "unsupported_request");
      result.push({ slug: model.value.slug, displayName: model.value.display_name });
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
        (retry && get("chatgpt-account", retry.view.accountId!, AccountRecord)
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
        if (!get("chatgpt-link", item.body, LinkRecord)) storage.take("chatgpt-state", item.id);

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

      const flow = Schema.decodeUnknownSync(FlowRecord)(
        JSON.parse(await open(kek, `chatgpt-link:${id}`, link.envelope)),
      );

      const url = new URL(config.authorizationEndpoint);

      const params = new URLSearchParams({
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
      });

      if (flow.clientId === config.clientId) params.set("agent_name_hint", "Kitties");
      else if (get("chatgpt-account", link.view.accountId!, AccountRecord)) {
        const row = readAccount(link.view.accountId!, epoch);

        // A retained ID token goes only into a server redirect to OpenAI.
        if (row.credentials)
          params.set("id_token_hint", (await credentials(link.view.accountId!, row)).idToken);

        if (row.account.email) params.set("login_hint", row.account.email);
      }

      if (flow.requestConsent) params.set("prompt", "consent");
      await guard(epoch);
      ensureLink(id, epoch);

      for (const [key, value] of params) url.searchParams.set(key, value);

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
        const flow = Schema.decodeUnknownSync(FlowRecord)(
          JSON.parse(await open(kek, `chatgpt-link:${id}`, originalEnvelope)),
        );

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
          const other = Schema.decodeUnknownSync(AccountRecord)(JSON.parse(existing.body));

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
        const tokens = Schema.decodeUnknownSync(TokenRecord)(
          JSON.parse(await open(kek, aad(id), old)),
        );

        const metadata = await jsonResponse(await authFetch(config.discoveryUri));

        if (
          metadata.issuer !== config.issuer ||
          !Schema.is(Schema.String)(metadata.revocation_endpoint) ||
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
        const row: AccountRow = Schema.decodeUnknownSync(AccountRecord)(JSON.parse(body));
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

export class ChatgptCredentials extends Context.Service<
  ChatgptCredentials,
  ReturnType<typeof makeChatgptStorage>
>()("@kitties/gateway/chatgpt-core/ChatgptCredentials") {
  static layer(storage: ChatgptStorageInput, kek: string, context: () => Promise<ChatgptContext>) {
    return Layer.sync(ChatgptCredentials, () =>
      ChatgptCredentials.of(makeChatgptStorage(storage, kek, context)),
    );
  }
}
