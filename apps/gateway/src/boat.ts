import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class BoatError extends Schema.TaggedError<BoatError, { readonly brand: unique symbol }>()(
  "BoatError",
  {
    code: Schema.String,
    status: Schema.Number,
    retryAfter: Schema.Number,
  },
) {}

export interface BoatSandbox {
  id: string;
  name: string;
  state: string;
  labels?: Record<string, string> | null;
  access?: string;
  archiveAfter?: string;
  hydrated?: boolean;
  snapshotAvailable?: boolean;
  lastSnapshotStatus?: string;
  stop?: { status: string; forced?: boolean };
  dataExpiredAt?: string | null;
}

export interface SavedSnapshot {
  name: string;
  snapshotId: string;
  sourceSandboxId: string;
  status: string;
  error?: string | null;
}

export const BoatSandboxResponse = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    state: Schema.String,
    labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    access: Schema.optional(Schema.String),
    archiveAfter: Schema.optional(Schema.String),
    hydrated: Schema.optional(Schema.Boolean),
    snapshotAvailable: Schema.optional(Schema.Boolean),
    lastSnapshotStatus: Schema.optional(Schema.String),
    stop: Schema.optional(
      Schema.Struct({ status: Schema.String, forced: Schema.optional(Schema.Boolean) }),
    ),
    dataExpiredAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export const BoatSavedSnapshotResponse = Schema.Struct({
  snapshot: Schema.Struct({
    name: Schema.String,
    snapshotId: Schema.String,
    sourceSandboxId: Schema.String,
    status: Schema.String,
    error: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

export const BoatInventoryResponse = Schema.Struct({
  sandboxes: Schema.Array(BoatSandboxResponse.fields.sandbox),
  pageInfo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        hasMore: Schema.optional(Schema.Boolean),
        nextCursor: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const CreateReceipt = Schema.Struct({
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
});

const BoatFailure = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,80}$/)),
});

export const readySandbox = (sandbox: BoatSandbox) =>
  ["provisioned", "idle", "busy", "ready", "running"].includes(sandbox.state) &&
  sandbox.hydrated !== false;

export const activeSandbox = (sandbox: BoatSandbox) =>
  !["archived", "blocked", "deleted", "stopped"].includes(sandbox.state);

export interface RemoteReceipt {
  remoteId: string;
  generation: number;
  key: string;
  body: string;
  at: number;
}

export function ownsSandbox(
  sandbox: BoatSandbox,
  deployment: string,
  kittyId: string,
  generation: number,
  receipt?: RemoteReceipt,
) {
  if (sandbox.name !== `kn-${kittyId}-g${generation}` || sandbox.access === "shared") return false;
  const labels = sandbox.labels ?? {};

  if (
    labels["kitties.deployment"] === deployment &&
    labels["kitties.kitty"] === kittyId &&
    labels["kitties.generation"] === String(generation)
  )
    return true;

  // Boat may strip labels on a restore. Only an exact persisted create receipt
  // whose original request belongs to this deployment may substitute for them.
  if (
    !receipt ||
    sandbox.id !== receipt.remoteId ||
    receipt.generation !== generation ||
    !receipt.key
  )
    return false;

  try {
    const body = Schema.decodeUnknownSync(CreateReceipt)(JSON.parse(receipt.body));

    return (
      body.name === sandbox.name &&
      body.labels["kitties.deployment"] === deployment &&
      body.labels["kitties.kitty"] === kittyId &&
      body.labels["kitties.generation"] === String(generation)
    );
  } catch {
    return false;
  }
}

export function boatClient(key: string) {
  function request(method: string, path: string): Effect.Effect<Schema.Json | void, BoatError>;
  function request<A>(
    method: string,
    path: string,
    responseSchema: Schema.Codec<A>,
    body?: Schema.Json,
    headers?: Record<string, string>,
  ): Effect.Effect<A, BoatError>;
  function request<A>(
    method: string,
    path: string,
    responseSchema?: Schema.Codec<A>,
    body?: Schema.Json,
    headers: Record<string, string> = {},
  ) {
    return Effect.tryPromise({
      try: async () => {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...headers,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(path.endsWith("/commands") ? 600000 : 60000),
        };

        if (body !== undefined)
          init.body = Schema.is(Schema.String)(body) ? body : JSON.stringify(body);
        const response = await fetch("https://boat.dev/api/v1" + path, init);

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new BoatError({
            code: Schema.is(BoatFailure)(data) ? data.code : "BOAT_UNAVAILABLE",
            status: response.status,
            retryAfter: Math.min(300, Number(response.headers.get("Retry-After")) || 5),
          });
        }

        const value = response.status === 204 ? undefined : await response.json();

        return responseSchema
          ? Schema.decodeUnknownSync(responseSchema)(value)
          : Schema.decodeUnknownSync(Schema.Union([Schema.Json, Schema.Void]))(value);
      },
      catch: (cause) =>
        cause instanceof BoatError
          ? cause
          : new BoatError({ code: "BOAT_UNAVAILABLE", status: 0, retryAfter: 5 }),
    });
  }

  const inventory = Effect.gen(function* () {
    const found: BoatSandbox[] = [];
    let cursor = "";

    for (let page = 0; page < 100; page++) {
      const reply = yield* request(
        "GET",
        "/sandboxes?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        BoatInventoryResponse,
      );

      found.push(...reply.sandboxes);

      if (!reply.pageInfo?.hasMore) return found;

      if (!reply.pageInfo.nextCursor || reply.pageInfo.nextCursor === cursor)
        return yield* Effect.fail(
          new BoatError({ code: "INVENTORY_INCOMPLETE", status: 0, retryAfter: 5 }),
        );
      cursor = reply.pageInfo.nextCursor;
    }

    return yield* Effect.fail(
      new BoatError({ code: "INVENTORY_INCOMPLETE", status: 0, retryAfter: 5 }),
    );
  });

  return {
    request,
    inventory,
    get: (id: string) =>
      request("GET", "/sandboxes/" + encodeURIComponent(id), BoatSandboxResponse).pipe(
        Effect.map((value) => value.sandbox),
      ),
    saved: (name: string) =>
      request(
        "GET",
        "/saved-snapshots/" + encodeURIComponent(name),
        BoatSavedSnapshotResponse,
      ).pipe(Effect.map((value) => value.snapshot)),
  };
}
