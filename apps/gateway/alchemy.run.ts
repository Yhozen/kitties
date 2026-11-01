import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import Gateway from "./src/worker.ts";
import { GuestAssets } from "./src/resources.ts";
import { KittyDO } from "./src/kitty.ts";
import Verification from "./src/verification.ts";
import AcceptanceFixture from "./src/acceptance-fixture.ts";
import OAuthIngress from "./src/oauth-ingress.ts";
import HookIngress from "./src/hook-ingress.ts";

export default Alchemy.Stack(
  "KittiesNext",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const assets = yield* GuestAssets;
    const worker = yield* Gateway;
    yield* HookIngress;
    yield* OAuthIngress;
    const stage = yield* Stage;
    if (stage === "next") {
      yield* Verification;
      yield* AcceptanceFixture;
    }
    const ingress = yield* Cloudflare.Worker("GuestIngress", {
      main: new URL("./src/guest-ingress.ts", import.meta.url).pathname,
      dev: { port: 1338, strictPort: true },
      domain: stage === "local" ? undefined : `guest-${stage}.kitties.rccpr.tech`,
      workersDev: false,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        redactQueryString: true,
      },
      env: {
        PUBLIC_URL: Cloudflare.Worker.URL,
        RELEASE_KEY: yield* Config.Redacted("KITTIES_RELEASE_KEY"),
        RELEASES: assets,
        KITTIES: Cloudflare.DurableObject<KittyDO>("KittyDO", { scriptName: worker.workerName }),
      },
    });
    return { url: worker.url, guestUrl: ingress.url, assetsBucket: assets.bucketName };
  }),
);
