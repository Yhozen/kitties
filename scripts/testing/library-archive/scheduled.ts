import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";
import { RecoveryOperationId } from "../../../apps/gateway/src/library-recovery-records.ts";
import { LibraryCapturePruneClock } from "../../../apps/gateway/src/library-capture-prune-clock.ts";
import { LibraryCapturePruning } from "../../../apps/gateway/src/library-capture-pruning.ts";
import { LibraryControl } from "../../../apps/gateway/src/library-control.ts";
import { LibraryArchiveProbe } from "./probe.ts";
import {
  LibraryPruneSweep,
  LibraryPruneSweepResult,
} from "../../../apps/gateway/src/workflows/library-prune.ts";

export const ArchiveScheduledPrune = Workflow.make("OwnedLibraryPruneSweep", {
  payload: { id: RecoveryOperationId },
  success: LibraryPruneSweepResult,
  error: Schema.String,
  idempotencyKey: ({ id }) => id,
}).annotate(Workflow.SuspendOnFailure, true);

/** Only production pruning calls get policy time; the Workflow engine Clock stays real. */
const ClockedPruning = Layer.effect(
  LibraryCapturePruning,
  Effect.gen(function* () {
    const pruning = yield* LibraryCapturePruning;
    const clock = yield* LibraryCapturePruneClock;

    return LibraryCapturePruning.of({
      prune: (request) => pruning.prune(request).pipe(Effect.provideService(Clock.Clock, clock)),
      abandon: (request) =>
        pruning.abandon(request).pipe(Effect.provideService(Clock.Clock, clock)),
    });
  }),
);

const ObservedDiscovery = Layer.effect(
  LibraryControl,
  Effect.gen(function* () {
    const control = yield* LibraryControl;
    const probes = yield* LibraryArchiveProbe;

    return LibraryControl.of({
      ...control,
      capturePruneCandidates: (request) =>
        control
          .capturePruneCandidates(request)
          .pipe(
            Effect.tap(() =>
              probes.getByName("probe").count("scheduled-discovery").pipe(Effect.orDie),
            ),
          ),
    });
  }),
);

/** Runs the exact production Activity program, without legacy Purge actors. */
export const ArchiveScheduledSweepLive = Workflows.layer(
  ArchiveScheduledPrune,
  Effect.gen(function* () {
    const sweep = yield* LibraryPruneSweep;

    return Effect.fn(function* (_payload) {
      return yield* sweep.run();
    });
  }),
).pipe(
  Layer.provide(
    LibraryPruneSweep.layer.pipe(Layer.provide(Layer.merge(ClockedPruning, ObservedDiscovery))),
  ),
  Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine()),
);
