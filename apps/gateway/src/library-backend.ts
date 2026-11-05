import { LibraryArchiveLive, LibraryArchiveJournalLive } from "./library-archive.ts";
import { LibraryArchiveOperations } from "./library-archive-operations.ts";
import { LibraryCapturePruning } from "./library-capture-pruning.ts";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { LibraryModel } from "@kitties/domain/Library.model";
import { RecoveryHooks } from "@alchemy.run/cloudflare/Domain/RecoveryHooks";
import { ALCHEMY_PHASE } from "alchemy";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LibraryControl, LibraryControlAdapters } from "./library-control.ts";
import {
  LibraryBackfillScope,
  LibraryObjectAdministration,
  libraryRecoveryHooksLayer,
} from "./library-recovery-host.ts";
import { LibrarySnapshot, LibrarySnapshotSource, LibraryCatalogue } from "./library-snapshot.ts";
import { LibraryRecoveryCoordinator } from "./library-recovery-coordinator.ts";

export const LibraryControlLive = LibraryControlAdapters.pipe(
  Layer.provideMerge(LibraryControl.layer),
);

// This immutable creation scope is deployment input. After restoring a lineage,
// update it explicitly before deploying a new native backfill; never read CURRENT
// during creation or replay to silently reassign an existing operation.
let plannedHooks: Context.Context<RecoveryHooks | LibraryObjectAdministration> | undefined;

export const LibraryRecoveryHooksLive = Layer.unwrap(
  Effect.gen(function* () {
    const epoch = yield* Config.Int("KITTIES_LIBRARY_ROLLOUT_EPOCH").pipe(Config.withDefault(1));

    const lineage = yield* Config.String("KITTIES_LIBRARY_ROLLOUT_LINEAGE").pipe(
      Config.withDefault("library-1"),
    );

    const rollout = yield* Schema.decodeUnknownEffect(LibraryBackfillScope)({
      modelName: "LibraryModel",
      layout: 0,
      libraryId: "owner",
      epoch,
      lineage,
    });

    const live = libraryRecoveryHooksLayer(rollout).pipe(Layer.provide(LibraryControlLive));

    // Plan re-evaluates Gateway for each Worker that binds it; the provider requires one hook
    // identity per host. Bundling folds the runtime flag to true, removing this branch.
    if (globalThis.__ALCHEMY_RUNTIME__ || (yield* ALCHEMY_PHASE) !== "plan") return live;

    return Layer.effectContext(
      Effect.gen(function* () {
        plannedHooks ??= yield* Layer.build(live);

        return plannedHooks;
      }),
    );
  }).pipe(Effect.orDie),
);

const LibraryHosted = LibraryModel.layer(Layer.empty).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects({ recovery: LibraryRecoveryHooksLive })),
);

/** One memoized host and hook identity shared by HTTP, Home and recovery callers. */
const LibraryServices = Layer.mergeAll(
  LibrarySnapshot.layer,
  LibraryCatalogue.layer,
  LibraryRecoveryCoordinator.layer,
  LibraryArchiveLive,
  LibraryArchiveJournalLive,
).pipe(
  Layer.provide(LibrarySnapshotSource.layer),
  Layer.provideMerge(Layer.mergeAll(LibraryHosted, LibraryControlLive, LibraryRecoveryHooksLive)),
);

export const LibraryBackend = Layer.merge(
  LibraryArchiveOperations.layer,
  LibraryCapturePruning.layer,
).pipe(Layer.provideMerge(LibraryServices));
