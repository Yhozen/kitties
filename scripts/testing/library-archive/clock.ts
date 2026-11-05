import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LibraryCapturePruneClock } from "../../../apps/gateway/src/library-capture-prune-clock.ts";

/** The local host binds one policy timestamp per process; ordinary Clock stays real. */
export const ArchivePruneClockLive = Layer.effect(
  LibraryCapturePruneClock,
  Effect.gen(function* () {
    const environment = yield* Cloudflare.WorkerEnvironment;
    const clock = yield* Clock.Clock;

    const { LIBRARY_ARCHIVE_FIXTURE_NOW: now } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ LIBRARY_ARCHIVE_FIXTURE_NOW: Schema.NullOr(Schema.Int) }),
    )(environment).pipe(Effect.orDie);

    if (now === null) return clock;

    return {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.succeed(now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1000000n,
      currentTimeNanos: Effect.succeed(BigInt(now) * 1000000n),
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
    } satisfies Clock.Clock;
  }),
);
