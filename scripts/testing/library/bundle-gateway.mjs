// Local compilation only: no Cloudflare credentials, state store or deployment.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";

const root = resolve(import.meta.dirname, "../../..");
const output = join(root, ".context/library-gateway-bundles");
const specs = JSON.parse(readFileSync(join(root, "apps/gateway/deployment.json"), "utf8"));
const results = [];

for (const [id, spec] of Object.entries(specs)) {
  const exports = {
    ...Object.fromEntries(spec.classes.map((name) => [name, { kind: "durableObject" }])),
    ...Object.fromEntries((spec.workflows ?? []).map((name) => [name, { kind: "workflow" }])),
  };

  const bundle = await Effect.runPromise(
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;

      return yield* bundler.build({
        id,
        main: join(root, spec.main),
        entry: spec.kind === "external" ? { kind: "external" } : { kind: "effect", exports },
        stack: { name: "KittiesNext", stage: "local" },
        compatibility: { date: "2026-10-12", flags: ["nodejs_compat"] },
        extraOptions: undefined,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  assert.ok(bundle.files.length > 0);

  for (const file of bundle.files) {
    const target = join(output, id, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  results.push({
    id,
    hash: bundle.hash,
    exports: Object.keys(exports),
    files: bundle.files.length,
  });
}

writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));

console.log(JSON.stringify({ verdict: "PASS", output, results }));
