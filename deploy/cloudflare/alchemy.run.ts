import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import { Random } from "alchemy/Random";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export default Alchemy.Stack(
  "Kitties",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const boatKey = yield* Config.Redacted("BOAT_DEV_API_KEY");
    const openaiKey = yield* Config.Redacted("OPENAI_API_KEY");
    const domain = yield* Config.String("KITTIES_CLOUDFLARE_DOMAIN").pipe(
      Config.withDefault("kitties.rccpr.tech"),
    );
    const email = yield* Config.String("KITTIES_ACCESS_EMAIL").pipe(
      Config.withDefault("gabriel@garox.org"),
    );
    const restoreSnapshot = yield* Config.schema(
      Schema.String.check(Schema.isPattern(/^(?:latest|[a-f0-9]{8,64})?$/)),
      "KITTIES_RESTORE_SNAPSHOT",
    ).pipe(Config.withDefault(""));
    const restoredVault = yield* Config.Redacted("KITTIES_VAULT_KEY").pipe(
      Config.option,
    );
    const token = yield* Random("GatewayAuthSecret", { bytes: 32 });
    const vault = yield* Random("VaultKey", { bytes: 32 });
    const backupPassword = yield* Random("BackupPassword", { bytes: 32 });
    const bucket = yield* Cloudflare.R2.Bucket("State").pipe(
      RemovalPolicy.retain(),
    );
    const backups = yield* Cloudflare.R2.Bucket("Backups").pipe(
      RemovalPolicy.retain(),
    );
    const verify = yield* Config.Boolean("KITTIES_LIVE_VERIFY").pipe(
      Config.withDefault(false),
    );
    const image = Cloudflare.Container("GatewayImage", {
      schedulingPolicy: "durable_object",
      observability: { logs: { enabled: true } },
      context: fileURLToPath(new URL("../..", import.meta.url)),
      dockerfile: fileURLToPath(new URL("./Dockerfile", import.meta.url)),
    });
    const worker = yield* Cloudflare.Worker("Gateway", {
      main: fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
      domain,
      workersDev: false,
      crons: ["*/5 * * * *"],
      access: {
        name: "Kitties",
        sessionDuration: "24h",
        policies: [{ decision: "allow", include: [{ email }] }],
      },
      env: {
        GATEWAY: Cloudflare.DurableObject("Gateway", { containers: [image] }),
        COORDINATOR: Cloudflare.DurableObject("Coordinator"),
        STATE: bucket,
        BACKUPS: backups,
        RESTIC_PASSWORD: backupPassword.text,
        PUBLIC_URL: `https://${domain}`,
        ACCESS_EMAIL: email,
        BOAT_DEV_API_KEY: boatKey,
        OPENAI_API_KEY: openaiKey,
        KITTIES_TOKEN: token.text,
        KITTIES_RESTORE_SNAPSHOT: restoreSnapshot,
        KITTIES_VAULT_KEY: Option.isSome(restoredVault)
          ? restoredVault.value
          : Output.map(vault.text, (secret) =>
              Redacted.make(
                Buffer.from(Redacted.value(secret), "hex").toString("base64"),
              ),
            ),
      },
    });
    if (verify) {
      yield* Cloudflare.Worker("Verification", {
        main: fileURLToPath(new URL("./src/verification.ts", import.meta.url)),
        workersDev: false,
        crons: ["* * * * *"],
        env: {
          TEST: Cloudflare.DurableObject("Verification"),
          COORDINATOR: Cloudflare.DurableObject("Coordinator", {
            scriptName: worker.workerName,
          }),
          GATEWAY: Cloudflare.DurableObject("Gateway", {
            scriptName: worker.workerName,
          }),
          KITTIES_TOKEN: token.text,
          PUBLIC_URL: `https://${domain}`,
        },
      });
    }
    return { url: worker.url };
  }),
);
