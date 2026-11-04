import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", {
  code: Schema.String,
  status: Schema.Number,
  retryAfter: Schema.Number,
}) {}

export interface BoatSandbox {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
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
    const body = JSON.parse(receipt.body) as { name: string; labels: Record<string, string> };

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
  const request = <A>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch("https://boat.dev/api/v1" + path, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
          redirect: "manual",
          signal: AbortSignal.timeout(path.endsWith("/commands") ? 600000 : 60000),
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { code?: string };
          throw new BoatError({
            code:
              typeof data.code === "string" && /^[a-z0-9_]{1,80}$/.test(data.code)
                ? data.code
                : "BOAT_UNAVAILABLE",
            status: response.status,
            retryAfter: Math.min(300, Number(response.headers.get("Retry-After")) || 5),
          });
        }

        return response.status === 204 ? (undefined as A) : ((await response.json()) as A);
      },
      catch: (error) =>
        error instanceof BoatError
          ? error
          : new BoatError({ code: "BOAT_UNAVAILABLE", status: 0, retryAfter: 5 }),
    });

  const inventory = Effect.gen(function* () {
    const found: BoatSandbox[] = [];
    let cursor = "";

    for (let page = 0; page < 100; page++) {
      const reply = yield* request<{
        sandboxes: BoatSandbox[];
        pageInfo?: { hasMore: boolean; nextCursor?: string };
      }>("GET", "/sandboxes?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));

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
      request<{ sandbox: BoatSandbox }>("GET", "/sandboxes/" + encodeURIComponent(id)).pipe(
        Effect.map((value) => value.sandbox),
      ),
    saved: (name: string) =>
      request<{ snapshot: SavedSnapshot }>(
        "GET",
        "/saved-snapshots/" + encodeURIComponent(name),
      ).pipe(Effect.map((value) => value.snapshot)),
  };
}
