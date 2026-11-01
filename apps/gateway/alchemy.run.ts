import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import Gateway from "./src/worker.ts";
import Verification from "./src/verification.ts";

export default Alchemy.Stack(
  "KittiesNext",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Gateway;
    const stage = yield* Stage;
    if (stage === "next") yield* Verification;
    return { url: worker.url };
  }),
);
