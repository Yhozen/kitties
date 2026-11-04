import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import { readAssets } from "@alchemy.run/cloudflare/Workers/Assets";

// Application publishing uses Workers Scripts Write, without Alchemy's R2,
// Access, DNS, state-store or bucket-configuration reconciliation permissions.
const stage = process.argv[2];

assert(["next", "prod"].includes(stage), "Usage: node scripts/publish-app.mjs next|prod [--dry-run]");

const dry = process.argv.includes("--dry-run");
const token = process.env.CLOUDFLARE_WORKER_DEPLOY_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;

assert(token && account, "Deployment token and account ID are required");

const root = `https://api.cloudflare.com/client/v4/accounts/${account}`;

const request = async (endpoint, options = {}, bearer = token) => {
  const response = await fetch(root + endpoint, {
    ...options,
    headers: { Authorization: `Bearer ${bearer}`, ...options.headers },
  });

  const value = await response.json();

  if (!response.ok || !value.success)
    throw Error(`Cloudflare ${endpoint.split("?")[0]} failed (${response.status}, ${value.errors?.[0]?.code ?? "unknown"}): ${String(value.errors?.[0]?.message ?? "").replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 400)}`);

  return value.result;
};

const json = (body) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const specs = JSON.parse(fs.readFileSync("apps/gateway/deployment.json", "utf8"));
const scripts = await request("/workers/scripts");
const prepared = [];

// Finish every build and configuration check before changing a deployed Worker.
for (const [id, spec] of Object.entries(specs)) {
  const matches = scripts.filter((s) => ["alchemy:stack:KittiesNext", `alchemy:stage:${stage}`, `alchemy:id:${id}`].every((tag) => s.tags?.includes(tag)));
  assert.equal(matches.length, 1, `Expected one existing ${stage}/${id}; deploy infrastructure with Alchemy first`);
  const name = matches[0].id;
  const settings = await request(`/workers/scripts/${name}/settings`);
  const hosted = [...new Set(settings.bindings.filter((b) => b.type === "durable_object_namespace" && (!b.script_name || b.script_name === name)).map((b) => b.class_name))].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(hosted, [...spec.classes].sort((a, b) => a.localeCompare(b)), `${id} namespaces differ; update infrastructure with Alchemy first`);

  const bundle = await run(Effect.gen(function* () {
    const bundler = yield* WorkerBundle;

    return yield* bundler.build({
      id, main: path.resolve(spec.main),
      entry: spec.kind === "external" ? { kind: "external" } : { kind: "effect", exports: Object.fromEntries(hosted.map((name) => [name, { kind: "durableObject" }])) },
      stack: { name: "KittiesNext", stage },
      compatibility: { date: settings.compatibility_date, flags: settings.compatibility_flags },
      extraOptions: undefined,
    });
  }));

  const assets = spec.assets ? await run(readAssets({ directory: spec.assets, runWorkerFirst: true, notFoundHandling: "none" })) : undefined;
  prepared.push({ name, id, settings, bundle, assets });
  console.log(`Built ${stage}/${id}: ${bundle.hash}`);
}

if (dry) process.exit(0);

const contentType = (name) => ({ html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", ico: "image/x-icon", woff2: "font/woff2", webmanifest: "application/manifest+json" })[name.split(".").at(-1)] ?? "application/octet-stream";

for (const { name, id, settings, bundle, assets } of prepared) {
  let assetJwt;

  if (assets) {
    const session = await request(`/workers/scripts/${name}/assets-upload-session`, { method: "POST", ...json({ manifest: assets.manifest }) });
    assetJwt = session.buckets?.length ? undefined : session.jwt;
    const byHash = new Map(Object.entries(assets.manifest).map(([name, entry]) => [entry.hash, name]));

    for (const bucket of session.buckets ?? []) {
      const form = new FormData();

      for (const hash of bucket) {
        const file = byHash.get(hash); assert(file, "Unknown asset requested");
        const data = fs.readFileSync(path.join(assets.directory, file));
        form.set(hash, new Blob([data.toString("base64")], { type: contentType(file) }), hash);
      }

      const upload = await request("/workers/assets/upload?base64=true", { method: "POST", body: form }, session.jwt);

      if (upload.jwt) assetJwt = upload.jwt;
    }

    assert(assetJwt, "No completed asset upload session");
  }

  const metadata = {
    main_module: bundle.files[0].path,
    exports: Object.fromEntries(specs[id].classes.map((name) => [name, { type: "durable-object", storage: "sqlite" }])),
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    bindings: settings.bindings.filter((b) => b.type !== "secret_text").map((binding) => {
      if (binding.type !== "durable_object_namespace") return binding;
      const { namespace_id: _namespaceId, ...target } = binding;

      return target;
    }),
    keep_bindings: ["secret_text"],
    keep_assets: !assets,
    limits: settings.limits,
    observability: settings.observability,
    tags: settings.tags,
    logpush: settings.logpush,
    placement: settings.placement,
    tail_consumers: settings.tail_consumers,
  };

  if (assets) {
    const config = { run_worker_first: true, not_found_handling: "none" };

    if (assets._headers) config._headers = assets._headers;

    if (assets._redirects) config._redirects = assets._redirects;
    metadata.assets = { jwt: assetJwt, config };
  }

  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));

  for (const file of bundle.files) form.set(file.path, new Blob([file.content], { type: file.path.endsWith(".map") ? "application/source-map" : "application/javascript+module" }), file.path);
  await request(`/workers/scripts/${name}`, { method: "PUT", body: form });
  console.log(`Published ${stage}/${id}`);
}
