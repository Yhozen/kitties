import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

const workers = `
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class WorkerEntrypoint extends DurableObject {}
`;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: `data:text/javascript,${encodeURIComponent(workers)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { Gateway } = await import("./worker.ts");
hook.deregister();

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const data = new Map<string, unknown>();
  let initialized = Promise.resolve();
  let running = false;
  let labels: Record<string, string> = {};
  let exit = deferred();
  let probe = async (_signal: AbortSignal) => new Response("ok");
  let onStart = () => {};
  const counts = { starts: 0, monitors: 0, probes: 0, destroys: 0 };
  const signals: AbortSignal[] = [];
  const bridges: number[] = [];
  const epoch = () =>
    Number(
      db.prepare("SELECT value FROM state_meta WHERE key = 'epoch'").get()
        ?.value ?? 0,
    );
  const stop = (code: number) => {
    running = false;
    if (code === 0) exit.resolve();
    else
      exit.reject(
        Object.assign(new Error("Process failed"), { exitCode: code }),
      );
  };
  const container = {
    get running() {
      return running;
    },
    images: { GatewayImage: "test-image" },
    start(options: { labels: Record<string, string> }) {
      assert.equal(running, false);
      assert.deepEqual(bridges.slice(-2), [epoch(), epoch()]);
      counts.starts++;
      running = true;
      labels = options.labels;
      exit = deferred();
      onStart();
    },
    async inspect() {
      return running ? { image: "test-image", labels } : null;
    },
    monitor() {
      counts.monitors++;
      return exit.promise;
    },
    signal() {
      stop(0);
    },
    async destroy() {
      counts.destroys++;
      stop(0);
    },
    async setInactivityTimeout() {},
    async interceptOutboundHttp(_host: string, binding: { epoch: number }) {
      bridges.push(binding.epoch);
    },
    getTcpPort() {
      return {
        fetch(_url: string, options: { signal: AbortSignal }) {
          counts.probes++;
          signals.push(options.signal);
          return probe(options.signal);
        },
      };
    },
  };
  const storage = {
    sql: {
      exec(query: string, ...bindings: SqlStorageValue[]) {
        const rows = db
          .prepare(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          );
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T) {
      return callback();
    },
    async sync() {},
    async get(key: string) {
      return data.get(key);
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async setAlarm() {},
    async deleteAlarm() {},
  };
  const ctx = {
    container,
    storage,
    id: { toString: () => "fixture" },
    exports: {
      StateBridge: ({ props }: { props: { epoch: number } }) => props,
      BackupBridge: ({ props }: { props: { epoch: number } }) => props,
    },
    blockConcurrencyWhile(callback: () => Promise<void>) {
      initialized = callback();
    },
  };
  const env = {
    STATE: {},
    BACKUPS: {},
    RESTIC_PASSWORD: "fixture",
    PUBLIC_URL: "https://fixture.test",
    KITTIES_TOKEN: "fixture",
    KITTIES_VAULT_KEY: "fixture",
    KITTIES_RESTORE_SNAPSHOT: "",
    BOAT_DEV_API_KEY: "fixture",
    OPENAI_API_KEY: "fixture",
  };
  const gateway = new Gateway(
    ctx as unknown as ConstructorParameters<typeof Gateway>[0],
    env as ConstructorParameters<typeof Gateway>[1],
  );
  await initialized;
  return {
    gateway,
    counts,
    signals,
    epoch,
    stop,
    probe: (next: typeof probe) => {
      probe = next;
    },
    onStart: (next: typeof onStart) => {
      onStart = next;
    },
  };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("Expected asynchronous gateway state was not reached");
}

test("healthy requests do not accumulate native monitors or probe timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  for (let i = 0; i < 100; i++) await f.gateway.wake();
  assert.deepEqual(f.counts, {
    starts: 1,
    monitors: 0,
    probes: 100,
    destroys: 0,
  });
  t.mock.timers.tick(10 * 60_000);
  assert(f.signals.every((signal) => !signal.aborted));
  assert.equal(f.epoch(), 1);
});

test("slow hydration keeps its full readiness budget with one exit observer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  f.probe(async () => new Response("hydrating", { status: 503 }));
  const warming = f.gateway.wake();
  await until(() => f.counts.monitors === 1);
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(4 * 60_000);
    await until(() => f.counts.probes === i + 2);
    await setImmediate();
  }
  f.probe(async () => new Response("ok"));
  t.mock.timers.tick(250);
  await warming;
  assert.equal(f.counts.monitors, 1);
  assert.equal(f.counts.starts, 1);
  assert.equal(f.counts.destroys, 0);
  t.mock.timers.tick(10 * 60_000);
  assert(f.signals.every((signal) => !signal.aborted));
});

test("exit interrupts readiness, drains its request, and the next wake gets a fresh epoch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  f.probe(async () => new Response("hydrating", { status: 503 }));
  const warming = f.gateway.wake();
  const failed = assert.rejects(warming, /container stopped/);
  await until(() => f.counts.monitors === 1);
  let pending = 0;
  f.probe(
    (signal) =>
      new Promise((_resolve, reject) => {
        pending++;
        signal.addEventListener(
          "abort",
          () => {
            pending--;
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      }),
  );
  t.mock.timers.tick(250);
  await until(() => pending === 1);
  const concurrent = assert.rejects(f.gateway.wake(), /container stopped/);
  f.stop(1);
  await Promise.all([failed, concurrent]);
  assert.equal(pending, 0);
  assert.equal(f.counts.starts, 1);
  const probes = f.counts.probes;
  t.mock.timers.tick(10 * 60_000);
  await setImmediate();
  assert.equal(f.counts.probes, probes);
  f.probe(async () => new Response("ok"));
  await f.gateway.wake();
  assert.equal(f.counts.starts, 2);
  assert.equal(f.epoch(), 2);
  assert.equal(
    (await f.gateway.stateRequest(new Request("http://state/v1/manifest"), 1))
      .status,
    409,
  );
  assert.equal(
    (await f.gateway.stateRequest(new Request("http://state/v1/manifest"), 2))
      .status,
    200,
  );
  await f.gateway.retire();
  await assert.rejects(f.gateway.wake(), /unavailable/);
  assert.equal(f.counts.starts, 2);
});

test("an exit before monitor attachment cancels the retry delay without waiting ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  f.onStart(() => f.stop(0));
  f.probe(async () => {
    throw new Error("Container is stopped");
  });
  await assert.rejects(f.gateway.wake(), /container stopped/);
  assert.equal(Date.now(), 0);
  t.mock.timers.tick(10 * 60_000);
  await setImmediate();
  assert.deepEqual(f.counts, {
    starts: 1,
    monitors: 1,
    probes: 1,
    destroys: 0,
  });
  assert(f.signals.every((signal) => !signal.aborted));
});

test("a retired generation cannot restart after readiness fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await fixture();
  f.probe(async () => new Response("hydrating", { status: 503 }));
  const failed = assert.rejects(f.gateway.wake(), /retired|container stopped/);
  await until(() => f.counts.monitors === 1);
  const retiring = f.gateway.retire();
  f.stop(1);
  await Promise.all([failed, retiring]);
  await assert.rejects(f.gateway.wake(), /unavailable/);
  assert.equal(f.counts.starts, 1);
});
