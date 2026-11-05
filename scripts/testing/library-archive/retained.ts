import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  LibraryArchiveCaptureSourceLive,
  LibraryArchiveJournalLive,
} from "../../../apps/gateway/src/library-archive.ts";
import {
  LibraryArchiveKey,
  LibraryArchiveObjects,
  LibraryRetainedArchive,
  LIBRARY_ARCHIVE_OBJECT_BYTES,
} from "../../../apps/gateway/src/library-retained-archive.ts";
import { LibraryArchiveError } from "../../../apps/gateway/src/library-retained-archive-store.ts";
import { libraryImageBytes, libraryImageDigest } from "../../../apps/gateway/src/library-image.ts";
import { LibraryArchiveProbe } from "./probe.ts";

const Envelope = Schema.fromJsonString(
  Schema.Struct({ kid: Schema.Literal("v1"), iv: Schema.String, ct: Schema.String }),
);

export const archiveObjectEvidence = Effect.fnUntraced(function* (key: string) {
  const objects = yield* LibraryArchiveObjects;
  const object = yield* objects.get(key, LIBRARY_ARCHIVE_OBJECT_BYTES);

  if (object === null) return yield* new LibraryArchiveError({ reason: "incomplete" });
  yield* Schema.decodeUnknownEffect(Envelope)(object.body).pipe(
    Effect.mapError(() => new LibraryArchiveError({ reason: "invalid" })),
  );

  const cipherSha256 = yield* libraryImageDigest(object.body).pipe(
    Effect.mapError(() => new LibraryArchiveError({ reason: "storage" })),
  );

  return {
    key,
    cipherSha256,
    uploadedAt: object.uploadedAt,
    bytes: libraryImageBytes(object.body),
    encryptedEnvelope: true,
    containsSeedPlaintext: object.body.includes("Immutable archive seed"),
  };
});

const StorageLive = Layer.unwrap(
  Effect.gen(function* () {
    // SAFETY: owned host.mjs injects the native EXPORTS R2 binding and an explicit private KEK;
    // it allows no external bindings. The key is decoded before entering the encryption service.
    const env = (yield* Cloudflare.WorkerEnvironment) as {
      readonly EXPORTS: Pick<cf.R2Bucket, "get" | "put">;
      readonly KITTIES_KEK: unknown;
    };

    const key = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    )(env.KITTIES_KEK).pipe(Effect.orDie);

    return Layer.merge(
      LibraryArchiveObjects.layerR2({
        get: (key) => env.EXPORTS.get(key),
        put: (key, body, options) => env.EXPORTS.put(key, body, options),
      }),
      Layer.succeed(LibraryArchiveKey, { value: Redacted.make(key) }),
    );
  }),
);

/** A real successful conditional R2 write remains unacknowledged when this gate is held. */
const ObservedObjects = Layer.effect(
  LibraryArchiveObjects,
  Effect.gen(function* () {
    const objects = yield* LibraryArchiveObjects;
    const probes = yield* LibraryArchiveProbe;
    const probe = () => probes.getByName("probe");

    return LibraryArchiveObjects.of({
      get: (key, maximum) =>
        objects
          .get(key, maximum)
          .pipe(Effect.tap(() => probe().count("remote-get").pipe(Effect.orDie))),
      putIfAbsent: (key, body) =>
        objects.putIfAbsent(key, body).pipe(
          Effect.tap(() => probe().count("remote-put").pipe(Effect.orDie)),
          Effect.tap(() =>
            archiveObjectEvidence(key).pipe(
              Effect.provideService(LibraryArchiveObjects, objects),
              Effect.flatMap((evidence) => probe().hit("upload", evidence).pipe(Effect.orDie)),
            ),
          ),
        ),
    });
  }),
).pipe(Layer.provide(StorageLive));

export const ArchiveRetainedLive = LibraryRetainedArchive.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LibraryArchiveJournalLive,
      LibraryArchiveCaptureSourceLive,
      StorageLive,
      ObservedObjects,
    ),
  ),
);
