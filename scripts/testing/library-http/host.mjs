// Local-only bootstrap: no CLI, deployment planner, RemoteBindings or credential layers.
import { realpathSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { localState, State } from "alchemy/State";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import * as Runtime from "@alchemy.run/cloudflare-runtime/core/Runtime";
import * as RuntimeServices from "@alchemy.run/cloudflare-runtime/core/RuntimeServices";
import * as Globals from "@alchemy.run/cloudflare-runtime/core/globals/Globals";
import * as Storage from "@alchemy.run/cloudflare-runtime/core/globals/Storage";
import * as Internet from "@alchemy.run/cloudflare-runtime/core/globals/Internet";
import * as Registry from "@alchemy.run/cloudflare-runtime/core/registry/Registry";
import * as RegistryProxy from "@alchemy.run/cloudflare-runtime/core/registry/RegistryProxy";
import * as Docker from "@alchemy.run/cloudflare-runtime/core/Docker";
import * as Workerd from "@alchemy.run/cloudflare-runtime/core/workerd/Workerd";
import * as DO from "@alchemy.run/cloudflare-runtime/core/bindings/DurableObjectNamespace";
import * as NativeWorkflows from "@alchemy.run/cloudflare-runtime/core/bindings/workflows/Workflows";
import * as Plugin from "@alchemy.run/cloudflare-runtime/core/Plugin";
import * as PluginContext from "@alchemy.run/cloudflare-runtime/core/PluginContext";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const outputRoot = join(root, ".context/library-http-check");

if (!process.argv[2]) throw Error("Use run.mjs to allocate an isolated local-only run");

const stateDir = resolve(process.argv[2]);

if (!stateDir.startsWith(outputRoot + "/"))
  throw Error("State must be inside .context/library-http-check");

mkdirSync(stateDir, { recursive: true });

const req = createRequire(import.meta.url);
const cloudflareRoot = dirname(realpathSync(req.resolve("@alchemy.run/cloudflare/package.json")));
const Package = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const version = Schema.decodeUnknownSync(Package)(
  readFileSync(join(cloudflareRoot, "package.json"), "utf8"),
).version;

const runtimeRoot = realpathSync(join(cloudflareRoot, "..", "cloudflare-runtime"));

const runtimeVersion = Schema.decodeUnknownSync(Package)(
  readFileSync(join(runtimeRoot, "package.json"), "utf8"),
).version;

if (runtimeVersion !== version || version !== "2.0.0-beta.85")
  throw Error("Audit local bootstrap when changing pinned Alchemy/runtime version");

const engineFiles = Object.fromEntries(
  [
    "src/Workflows/DurableObjectEngine.ts",
    "lib/Workflows/DurableObjectEngine.js",
    "lib/Workflows/DurableObjectEngine.js.map",
    "lib/Workflows/DurableObjectEngine.d.ts",
  ].map((name) => [
    name,
    createHash("sha256")
      .update(readFileSync(join(cloudflareRoot, name)))
      .digest("hex"),
  ]),
);

// Paths is not a public subpath in beta85. The exact version guard above makes
// this one internal bootstrap dependency explicit; all runtime/worker APIs are public.
/** @typedef {Exclude<Layer.Services<typeof Registry.RegistryLive>, import('effect/FileSystem').FileSystem | import('effect/Path').Path>} RuntimePaths */
/** @type {{ PathsLive: Layer.Layer<RuntimePaths, never, import('effect/FileSystem').FileSystem | import('effect/Path').Path> }} */
const Paths = await import(
  pathToFileURL(join(runtimeRoot, "dist/core/node/internal/Paths.mjs")).href
);

const config = Layer.succeed(AlchemyContext, {
  dotAlchemy: join(stateDir, "alchemy"),
  dev: true,
  adopt: false,
  updateStateStore: false,
});

class DirectEntry extends Plugin.Service()("cloudflare-runtime/plugin/OwnedHttpDirect") {}

// beta85's dev entry middleware forwards through a service binding. An extra
// native HTTP socket isolates that simulator hop from the actual Worker entry.
// "user-worker" is the pinned Runtime service name, not a production binding.
const directEntry = Layer.succeed(
  DirectEntry,
  Effect.gen(function* () {
    const { worker } = yield* PluginContext.PluginContext;

    return {
      sockets: [
        { name: "owned-http-direct", address: "127.0.0.1:0", service: { name: "user-worker" } },
      ],
      start: (ports) =>
        Effect.sync(() =>
          emit({
            event:
              worker.name === "owned-library-http-signal" ? "signal-direct-ready" : "direct-ready",
            url: `http://127.0.0.1:${ports["owned-http-direct"]}/`,
          }),
        ),
    };
  }),
);

const localRuntime = Runtime.RuntimeLive.pipe(
  Layer.provideMerge(directEntry),
  Layer.provideMerge(RuntimeServices.layerLocalBindings()),
  Layer.provideMerge(RuntimeServices.layerProxy()),
  Layer.provide(Globals.GlobalsLive),
  Layer.provideMerge(RuntimeServices.layerLoopback()),
  Layer.provide(Storage.layerDisk(join(stateDir, "storage"))),
  Layer.provide(
    Layer.succeed(Internet.Internet, {
      name: "internet",
      network: { allow: ["127.0.0.1/32", "::1/128"], deny: [] },
    }),
  ),
  Layer.provideMerge(RegistryProxy.RegistryProxyLive),
  Layer.provideMerge(Registry.RegistryLive),
  Layer.provideMerge(Paths.PathsLive),
  Layer.provideMerge(Docker.DockerLive),
  Layer.provideMerge(Workerd.WorkerdLive),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_RUNTIME_HOME: join(stateDir, "runtime"),
        CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER: false,
      }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
);

/** @param {Schema.Json} event */
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

const program = Effect.gen(function* () {
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      const unchanged = Object.entries(engineFiles).every(
        ([name, hash]) =>
          createHash("sha256")
            .update(readFileSync(join(cloudflareRoot, name)))
            .digest("hex") === hash,
      );

      emit({ event: "engine-files-unchanged", unchanged });

      if (!unchanged) throw Error("Installed engine files changed during probe");
    }),
  );
  const store = yield* yield* State;

  if (store.id !== "local") throw Error("Remote state prohibited");
  emit({
    event: "local-state",
    id: store.id,
    storeVersion: yield* store.getVersion(),
    directory: stateDir,
  });
  const runtime = yield* Runtime.Runtime;

  const signalUrl = yield* runtime.start({
    name: "owned-library-http-signal",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    modules: [
      {
        name: "signal-worker.mjs",
        type: "ESModule",
        content: readFileSync(join(directory, "signal-worker.mjs"), "utf8"),
      },
    ],
    bindings: [],
    logging: {
      verbose: false,
      onOutput: (chunk, stream) => process.stderr.write(`[signal:${stream}] ${chunk}`),
    },
  });

  emit({ event: "signal-ready", url: String(signalUrl) });

  if (process.argv[3] === "signal") {
    emit({
      event: "ready",
      url: String(signalUrl),
      pid: process.pid,
      cloudflareRoot,
      version,
      engineFiles,
    });

    return yield* Effect.never;
  }

  const bundler = yield* WorkerBundle;

  const classes = [
    "RecoveryDO",
    "LibraryModel.DomainDirectory",
    "LibraryModel.LibraryAggregate",
    "LibraryModel.SkillDetailViewV1",
    "LibraryModel.SkillDetailViewV1Run",
  ];

  const exports = {
    ...Object.fromEntries(classes.map((name) => [name, { kind: "durableObject" }])),
    "LibraryModel.DomainBackfill": { kind: "workflow" },
  };

  const bundle = yield* bundler.build({
    id: "OwnedLibraryHttp",
    main: join(directory, "worker.ts"),
    compatibility: { date: "2026-01-01", flags: ["nodejs_compat", "enable_request_signal"] },
    stack: { name: "owned-library-http", stage: "local" },
    entry: { kind: "effect", exports },
    extraOptions: {
      output: { dir: join(stateDir, "bundle"), minify: false },
    },
  });

  const url = yield* runtime.start({
    name: "owned-library-http",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    modules: bundle.files.map((file) => ({
      name: basename(file.path),
      type: "ESModule",
      content: Schema.decodeUnknownSync(Schema.String)(file.content),
    })),
    durableObjectNamespaces: classes.map((className) => ({
      className,
      sql: true,
      uniqueKey: "owned-library-http-" + className,
    })),
    workflows: [
      { workflowName: "owned-library-backfill", className: "LibraryModel.DomainBackfill" },
    ],
    bindings: [
      ...classes.map((className) => DO.local({ binding: className, className })),
      NativeWorkflows.local({
        binding: "LibraryModel.DomainBackfill",
        workflowName: "owned-library-backfill",
        className: "LibraryModel.DomainBackfill",
      }),
    ],
    logging: {
      verbose: false,
      onOutput: (chunk, stream) => process.stderr.write(`[workerd:${stream}] ${chunk}`),
    },
    onRestart: (exit) =>
      emit({
        event: "workerd-restarted",
        exit: { code: exit.exitCode, signal: exit.signal ?? null },
      }),
  });

  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("Runtime address is not loopback");
  emit({
    event: "ready",
    url: String(url),
    pid: process.pid,
    hash: bundle.hash,
    cloudflareRoot,
    version,
    engineFiles,
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(localRuntime),
  Effect.provide(localState()),
  Effect.provide(config),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
);

const fiber = Effect.runFork(program);
let stopping = false;

const stop = () => {
  emit({
    event: "stop-request",
    listeners: process.listeners("SIGTERM").map((handler) => handler.name),
  });
  stopping = true;
  Effect.runFork(Fiber.interrupt(fiber));
};

// Rolldown loads signal-exit: a once listener disappears before its handler
// counts remaining listeners and would make it re-send SIGTERM during cleanup.
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);

const exit = await Effect.runPromise(Fiber.await(fiber));

for (const signal of ["SIGTERM", "SIGINT"]) process.removeListener(signal, stop);

if (Exit.isFailure(exit) && (!stopping || !Cause.hasInterruptsOnly(exit.cause))) {
  console.error(Cause.pretty(exit.cause));
  process.exitCode = 1;
}
