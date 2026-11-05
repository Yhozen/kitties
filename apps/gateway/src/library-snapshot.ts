import * as Aggregate from "@alchemy.run/domain/Aggregate";
import { Library } from "@kitties/domain/Library/Library.aggregate";
import { LibraryId } from "@kitties/domain/Library/Library.id";
import { FinalizedImport, LibraryState } from "@kitties/domain/Library/Library.state";
import { SkillDetail, SkillDetailRecord } from "@kitties/domain/Library/SkillDetail.view";
import { SkillDetailKey, detailOwner, skillDetailKey } from "@kitties/domain/Library/Skill.id";
import {
  LibraryVersion,
  SkillMetadata,
  acceptedSkillsForTurn,
} from "@kitties/domain/Library/Skill";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  LIBRARY_OWNER,
  LibraryAdmission,
  LibraryEpoch,
  LibraryEpochSource,
  LibraryRequestScope,
} from "./library-session.ts";

export class LibrarySnapshotUnavailable extends Schema.TaggedError<
  LibrarySnapshotUnavailable,
  { readonly brand: unique symbol }
>()("LibrarySnapshotUnavailable", {
  reason: Schema.Literals(["storage", "recovery", "not-ready", "changed", "timeout", "limit"]),
}) {}

const unavailable = () => new LibrarySnapshotUnavailable({ reason: "storage" });

/** Read boundary for coherent turn capture; it never mutates Domain state. */
export class LibrarySnapshotSource extends Context.Service<
  LibrarySnapshotSource,
  {
    readonly catalogue: (
      libraryId: LibraryId,
    ) => Effect.Effect<LibraryState, LibrarySnapshotUnavailable, LibraryRequestScope>;
    readonly detail: (
      key: SkillDetailKey,
      revision: number,
      timeoutMs: number,
    ) => Effect.Effect<
      Option.Option<SkillDetailRecord | null>,
      LibrarySnapshotUnavailable,
      LibraryRequestScope
    >;
  }
>()("@kitties/gateway/LibrarySnapshotSource") {
  static readonly layer = Layer.effect(
    LibrarySnapshotSource,
    Effect.gen(function* () {
      const libraries = yield* Library;
      const details = yield* SkillDetail;

      return LibrarySnapshotSource.of({
        catalogue: (libraryId) => libraries.state(libraryId).pipe(Effect.catchDefect(unavailable)),
        detail: (key, revision, timeoutMs) =>
          details
            .query(key, {
              atLeast: {
                stream: Aggregate.streamOf(Library.ref(detailOwner(key))),
                version: revision,
              },
              timeout: timeoutMs,
            })
            .pipe(Effect.mapError(unavailable), Effect.catchDefect(unavailable)),
      });
    }),
  );
}

export const LibrarySnapshotPolicy = Context.Reference<{
  readonly attempts: number;
  readonly totalMs: number;
  readonly detailMs: number;
}>("@kitties/gateway/LibrarySnapshotPolicy", {
  defaultValue: () => ({ attempts: 3, totalMs: 10000, detailMs: 3000 }),
});

export const AcceptedSkill = Schema.Struct({
  ...SkillDetailRecord.fields,
  status: Schema.Literal("accepted"),
});

export const CapturedLibrary = Schema.Struct({
  epoch: LibraryEpoch,
  catalogueRevision: LibraryVersion,
  skills: Schema.Array(AcceptedSkill),
});

export type CapturedLibrary = typeof CapturedLibrary.Type;

export const LibraryCatalogueMaxBytes = Context.Reference<number>(
  "@kitties/gateway/LibraryCatalogueMaxBytes",
  {
    defaultValue: () => 2 * 1024 * 1024,
  },
);

const matches = (metadata: SkillMetadata, detail: SkillDetailRecord, libraryId: LibraryId) =>
  detail.libraryId === libraryId &&
  detail.id === metadata.id &&
  detail.name === metadata.name &&
  detail.status === metadata.status &&
  detail.createdAt === metadata.createdAt &&
  detail.updatedAt === metadata.updatedAt &&
  detail.proposalRevision === metadata.proposalRevision &&
  detail.detailRevision === metadata.detailRevision;

const makeLibraryReader = Effect.gen(function* () {
  const source = yield* LibrarySnapshotSource;
  const epochs = yield* LibraryEpochSource;
  const admission = yield* LibraryAdmission;
  const policy = yield* LibrarySnapshotPolicy;

  const maxBytes = yield* LibraryCatalogueMaxBytes;

  const capture = Effect.fnUntraced(
    function* (selection: "turn" | "all") {
      const epoch = yield* epochs
        .current(LIBRARY_OWNER)
        .pipe(Effect.mapError(() => new LibrarySnapshotUnavailable({ reason: "recovery" })));

      const scope = Object.freeze({ libraryId: LIBRARY_OWNER, epoch });

      return yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < policy.attempts; attempt++) {
          yield* admission
            .check(scope)
            .pipe(Effect.mapError(() => new LibrarySnapshotUnavailable({ reason: "recovery" })));
          const before = yield* source.catalogue(LIBRARY_OWNER);

          if (!Schema.is(FinalizedImport)(before.importProgress))
            return yield* new LibrarySnapshotUnavailable({ reason: "not-ready" });

          const selected =
            selection === "turn" ? acceptedSkillsForTurn(before.active) : before.active;

          let bytes = 0;

          const found = yield* Effect.forEach(
            selected,
            (skill) =>
              source
                .detail(
                  skillDetailKey(LIBRARY_OWNER, skill.id),
                  skill.detailRevision,
                  policy.detailMs,
                )
                .pipe(
                  Effect.tap((result) =>
                    Effect.gen(function* () {
                      const value = Option.getOrNull(result);

                      if (value !== null)
                        bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;

                      if (selection === "all" && bytes > maxBytes)
                        return yield* new LibrarySnapshotUnavailable({ reason: "limit" });
                    }),
                  ),
                ),
            { concurrency: 4 },
          );

          const skills: Array<SkillDetailRecord> = [];

          for (let index = 0; index < selected.length; index++) {
            const detail = Option.getOrNull(found[index]);

            if (detail !== null && matches(selected[index], detail, LIBRARY_OWNER))
              skills.push(detail);
          }

          if (skills.length !== selected.length) continue;
          const after = yield* source.catalogue(LIBRARY_OWNER);

          if (before.catalogueRevision !== after.catalogueRevision) continue;

          // The second catalogue read is the capture's linearization point.
          // A concurrent removal after that point overlaps this capture; a removal
          // completed before capture cannot be omitted from the observed catalogue.
          yield* admission
            .check(scope)
            .pipe(Effect.mapError(() => new LibrarySnapshotUnavailable({ reason: "recovery" })));

          return { epoch, catalogueRevision: after.catalogueRevision, skills };
        }

        return yield* new LibrarySnapshotUnavailable({ reason: "changed" });
      }).pipe(Effect.provideService(LibraryRequestScope, scope));
    },
    Effect.timeoutOrElse({
      duration: policy.totalMs,
      orElse: () => new LibrarySnapshotUnavailable({ reason: "timeout" }),
    }),
  );

  return capture;
});

const makeLibrarySnapshot = Effect.map(makeLibraryReader, (read) => ({
  capture: () =>
    read("turn").pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(CapturedLibrary)(result).pipe(Effect.mapError(unavailable)),
      ),
    ),
}));

export class LibrarySnapshot extends Context.Service<
  LibrarySnapshot,
  Effect.Success<typeof makeLibrarySnapshot>
>()("@kitties/gateway/LibrarySnapshot") {
  static readonly layer = Layer.effect(LibrarySnapshot, makeLibrarySnapshot);
}

/** Bounded compatibility reads use the same catalogue/detail consistency barrier. */
export class LibraryCatalogue extends Context.Service<
  LibraryCatalogue,
  {
    readonly read: () => ReturnType<Effect.Success<typeof makeLibraryReader>>;
  }
>()("@kitties/gateway/LibraryCatalogue") {
  static readonly layer = Layer.effect(
    LibraryCatalogue,
    Effect.map(makeLibraryReader, (read) => ({ read: () => read("all") })),
  );
}
