import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "KittiesNext",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const domain = yield* Config.String("KITTIES_NEXT_DOMAIN").pipe(
      Config.withDefault("dev.kitties.rccpr.tech"),
    );
    const email = yield* Config.String("KITTIES_ACCESS_EMAIL").pipe(
      Config.withDefault("gabriel@garox.org"),
    );
    const worker = yield* Cloudflare.Worker("Gateway", {
      main: fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
      domain,
      workersDev: false,
      limits: { cpuMs: 300000 },
      observability: { enabled: true },
      assets: {
        directory: fileURLToPath(new URL("../web/public", import.meta.url)),
        runWorkerFirst: true,
        notFoundHandling: "none",
      },
      access: {
        name: "Kitties Next development",
        sessionDuration: "720h",
        policies: [{ decision: "allow", include: [{ email }] }],
      },
      env: { PUBLIC_URL: `https://${domain}`, ACCESS_EMAIL: email },
    });
    return { url: worker.url };
  }),
);
