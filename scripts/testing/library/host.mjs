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
import * as JsonBinding from "@alchemy.run/cloudflare-runtime/core/bindings/Json";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const outputRoot = join(root, ".context/library-check");

if (!process.argv[2]) throw Error("Use run.mjs to allocate an isolated local-only run");

const stateDir = resolve(process.argv[2]);

if (!stateDir.startsWith(outputRoot + "/"))
  throw Error("State must be inside .context/library-check");

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

const localRuntime = Runtime.RuntimeLive.pipe(
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
const mutant = process.env.LIBRARY_CHECK_MUTANT;

if (mutant && !["activation-nonce", "retained-authorization"].includes(mutant))
  throw Error("Unknown Library bundle mutant");

let mutationCount = 0;

const mutationPlugin = {
  name: "owned-library-regression-mutant",
  /** @param {string} code @param {string} id */
  transform(code, id) {
    if (!mutant || !id.endsWith("/apps/gateway/src/library-object-admin.ts")) return;

    const needle =
      mutant === "activation-nonce"
        ? "activating: guard().activating,"
        : "yield* environment.authorizeCapture(input.operationId, input.captureId)";

    const replacement = mutant === "activation-nonce" ? "activating: nonce," : "null";

    if (code.split(needle).length !== 2)
      throw Error("Library mutant anchor changed; audit it first");
    mutationCount += 1;
    emit({ event: "mutation", mutant, module: id });

    return { code: code.replace(needle, replacement), map: null };
  },
};

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
  const bundler = yield* WorkerBundle;

  const classes = [
    "RecoveryDO",
    "LibraryFixture",
    "HomeDO",
    "LibraryModel.DomainDirectory",
    "LibraryModel.LibraryAggregate",
    "LibraryModel.SkillDetailViewV1",
    "LibraryModel.SkillDetailViewV1Run",
  ];

  const exports = {
    ...Object.fromEntries(classes.map((name) => [name, { kind: "durableObject" }])),
    "LibraryModel.DomainBackfill": { kind: "workflow" },
    QueuedLibraryBackfill: { kind: "workflow" },
  };

  const bundle = yield* bundler.build({
    id: "OwnedLibraryRecovery",
    main: join(directory, "worker.ts"),
    compatibility: { date: "2026-01-01", flags: ["nodejs_compat"] },
    stack: { name: "owned-library-recovery", stage: "local" },
    entry: { kind: "effect", exports },
    extraOptions: {
      input: { plugins: [mutationPlugin] },
      output: { dir: join(stateDir, "bundle"), minify: false },
    },
  });

  if (mutant && mutationCount !== 1)
    throw Error("Expected exactly one build-only Library mutation");

  const runtime = yield* Runtime.Runtime;

  const url = yield* runtime.start({
    name: "owned-library-recovery",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: bundle.files.map((file) => ({
      name: basename(file.path),
      type: "ESModule",
      content: Schema.decodeUnknownSync(Schema.String)(file.content),
    })),
    durableObjectNamespaces: classes.map((className) => ({
      className,
      sql: true,
      uniqueKey: "owned-library-recovery-" + className,
    })),
    workflows: [
      { workflowName: "owned-library-backfill", className: "LibraryModel.DomainBackfill" },
      { workflowName: "queued-library-backfill", className: "QueuedLibraryBackfill" },
    ],
    bindings: [
      JsonBinding.local("KITTIES_KEK", createHash("sha256").update(stateDir).digest("hex")),
      ...classes.map((className) => DO.local({ binding: className, className })),
      NativeWorkflows.local({
        binding: "LibraryModel.DomainBackfill",
        workflowName: "owned-library-backfill",
        className: "LibraryModel.DomainBackfill",
      }),
      NativeWorkflows.local({
        binding: "QueuedLibraryBackfill",
        workflowName: "queued-library-backfill",
        className: "QueuedLibraryBackfill",
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
    mutant: mutant ?? null,
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
