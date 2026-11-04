import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OAuthCredentials, type OAuthConfig, type OAuthStorage } from "./oauth-core.ts";
import { open, seal } from "./secrets.ts";

const kek = "19".repeat(32);
const connectionId = "calendar-work";

const config: OAuthConfig = {
  issuer: "https://identity.example.com",
  authorizationEndpoint: "https://identity.example.com/authorize",
  tokenEndpoint: "https://identity.example.com/token",
  clientId: "kitties-client",
  clientSecret: "fixture-client-secret",
  scope: "calendar.read calendar.write",
  resource: "https://calendar.example.com/api",
  redirectUri: "https://gateway.example.com/oauth/callback",
  protectedUrl: "https://calendar.example.com/api",
};

class CredentialRecords implements OAuthStorage {
  private readonly rows = new Map<string, Map<string, string>>();

  get(kind: string, id: string) {
    return this.rows.get(kind)?.get(id) ?? null;
  }

  put(kind: string, id: string, body: string) {
    const records = this.rows.get(kind) ?? new Map<string, string>();
    records.set(id, body);
    this.rows.set(kind, records);
  }

  take(kind: string, id: string) {
    const body = this.get(kind, id);
    this.rows.get(kind)?.delete(id);

    return body;
  }
}

const begin = Effect.fnUntraced(function* () {
  const credentials = yield* OAuthCredentials;
  const result = yield* Effect.promise(() => credentials.begin(connectionId, config));
  const url = new URL(result.url);
  const state = Schema.decodeUnknownSync(Schema.String)(url.searchParams.get("state"));

  return { credentials, result, url, state };
});

const seedCredentials = Effect.fnUntraced(function* (
  storage: OAuthStorage,
  status: "ready" | "refreshing",
) {
  const envelope = yield* Effect.promise(() =>
    seal(
      kek,
      `oauth:${connectionId}:credentials`,
      JSON.stringify({ config, tokens: { accessToken: "saved-access-token", expiresAt: 0 } }),
    ),
  );

  storage.put(
    "oauth-credentials",
    connectionId,
    JSON.stringify({ status, revision: "saved-revision", envelope }),
  );
});

describe("OAuth credential Layer", () => {
  it.effect(
    "keeps PKCE and client secrets encrypted while binding the redirect to the saved flow",
    () => {
      const storage = new CredentialRecords();

      return Effect.gen(function* () {
        const { result, url, state } = yield* begin();
        expect(url.origin + url.pathname).toBe(config.authorizationEndpoint);
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("client_id")).toBe(config.clientId);
        expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
        expect(url.searchParams.get("scope")).toBe(config.scope);
        expect(url.searchParams.get("resource")).toBe(config.resource);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(state).toMatch(/^[a-zA-Z0-9_-]{43}$/);
        expect(storage.get("oauth-attempt", connectionId)).toBe(state);
        expect(url.searchParams.has("client_secret")).toBe(false);
        expect(url.searchParams.has("code_verifier")).toBe(false);

        const saved = Schema.decodeUnknownSync(Schema.String)(storage.get("oauth-flow", state));
        expect(saved).not.toContain(config.clientSecret);

        const envelope = Schema.decodeUnknownSync(
          Schema.Struct({ kid: Schema.String, iv: Schema.String, ct: Schema.String }),
        )(JSON.parse(saved));

        const plaintext = yield* Effect.promise(() =>
          open(kek, `oauth-flow:${state}:pkce`, envelope),
        );

        const flow = Schema.decodeUnknownSync(
          Schema.Struct({
            connectionId: Schema.String,
            verifier: Schema.String,
            config: Schema.Struct({ clientSecret: Schema.String }),
            expiresAt: Schema.Number,
          }),
        )(JSON.parse(plaintext));

        expect(flow.connectionId).toBe(connectionId);
        expect(flow.config.clientSecret).toBe(config.clientSecret);
        expect(flow.expiresAt).toBe(result.expiresAt);

        const digest = yield* Effect.promise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier)),
        );

        const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
      }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
    },
  );

  it.effect("consumes a callback synchronously before rejecting a different connection", () => {
    const storage = new CredentialRecords();

    return Effect.gen(function* () {
      const { credentials, state } = yield* begin();

      const pending = credentials.finish(
        state,
        "authorization-code",
        config.issuer,
        "other-connection",
      );

      const flowAfterCallback = storage.get("oauth-flow", state);
      yield* Effect.promise(() => expect(pending).rejects.toThrow("OAUTH_RESOURCE_MISMATCH"));
      expect(flowAfterCallback).toBeNull();
      expect(credentials.status(connectionId)).toBe("disconnected");
      expect(storage.get("oauth-credentials", "other-connection")).toBeNull();
    }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
  });

  it.effect("rejects an issuer mismatch and prevents replay of the consumed callback", () => {
    const storage = new CredentialRecords();

    return Effect.gen(function* () {
      const { credentials, state } = yield* begin();
      const wrongIssuer = "https://other-issuer.example.com";
      yield* Effect.promise(() =>
        expect(
          credentials.finish(state, "authorization-code", wrongIssuer, connectionId),
        ).rejects.toThrow("OAUTH_FLOW_EXPIRED"),
      );
      yield* Effect.promise(() =>
        expect(
          credentials.finish(state, "authorization-code", wrongIssuer, connectionId),
        ).rejects.toThrow("OAUTH_STATE_USED"),
      );
      expect(storage.get("oauth-credentials", connectionId)).toBeNull();
    }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
  });

  it.effect("fences a superseded flow while preserving the replacement attempt", () => {
    const storage = new CredentialRecords();

    return Effect.gen(function* () {
      const original = yield* begin();
      const replacement = yield* begin();
      expect(replacement.state).not.toBe(original.state);
      yield* Effect.promise(() =>
        expect(
          original.credentials.finish(
            original.state,
            "authorization-code",
            config.issuer,
            connectionId,
          ),
        ).rejects.toThrow("OAUTH_REVISION_CHANGED"),
      );
      expect(storage.get("oauth-flow", original.state)).toBeNull();
      expect(storage.get("oauth-flow", replacement.state)).not.toBeNull();
      expect(storage.get("oauth-attempt", connectionId)).toBe(replacement.state);
    }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
  });

  it.effect("does not consume a valid flow when the callback code is missing", () => {
    const storage = new CredentialRecords();

    return Effect.gen(function* () {
      const { credentials, state } = yield* begin();
      const saved = storage.get("oauth-flow", state);
      yield* Effect.promise(() =>
        expect(credentials.finish(state, "", config.issuer, connectionId)).rejects.toThrow(
          "OAUTH_INVALID_CALLBACK",
        ),
      );
      expect(storage.get("oauth-flow", state)).toBe(saved);
      expect(storage.get("oauth-attempt", connectionId)).toBe(state);
    }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
  });

  it.effect(
    "binds saved tokens to their resource and removes credentials and pending attempts on disconnect",
    () => {
      const storage = new CredentialRecords();

      return Effect.gen(function* () {
        yield* seedCredentials(storage, "ready");
        const { credentials, state } = yield* begin();
        expect(credentials.status(connectionId)).toBe("ready");
        const saved = storage.get("oauth-credentials", connectionId);
        yield* Effect.promise(() =>
          expect(
            credentials.token(connectionId, "https://other-resource.example.com/api"),
          ).rejects.toThrow("OAUTH_RESOURCE_MISMATCH"),
        );
        expect(storage.get("oauth-credentials", connectionId)).toBe(saved);

        const token = yield* Effect.promise(() =>
          credentials.token(connectionId, config.protectedUrl),
        );

        expect(token).toBe("saved-access-token");
        credentials.disconnect(connectionId);
        expect(credentials.status(connectionId)).toBe("disconnected");
        expect(storage.get("oauth-attempt", connectionId)).toBeNull();
        yield* Effect.promise(() =>
          expect(credentials.token(connectionId, config.protectedUrl)).rejects.toThrow(
            "OAUTH_AUTHORIZATION_REQUIRED",
          ),
        );
        yield* Effect.promise(() =>
          expect(
            credentials.finish(state, "authorization-code", config.issuer, connectionId),
          ).rejects.toThrow("OAUTH_REVISION_CHANGED"),
        );
      }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
    },
  );

  it.effect("fails closed after a restart leaves a durable refresh in progress", () => {
    const storage = new CredentialRecords();

    return Effect.gen(function* () {
      yield* seedCredentials(storage, "refreshing");
      const credentials = yield* OAuthCredentials;
      yield* Effect.promise(() =>
        expect(credentials.token(connectionId, config.protectedUrl)).rejects.toThrow(
          "OAUTH_REAUTHORIZE_REQUIRED",
        ),
      );
      expect(credentials.status(connectionId)).toBe("refreshing");
    }).pipe(Effect.provide(OAuthCredentials.layer(storage, kek)));
  });
});
