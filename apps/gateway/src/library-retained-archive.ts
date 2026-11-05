import type * as Cloudflare from "@cloudflare/workers-types";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { LibraryImagePart } from "./library-object-admin.ts";
import {
  libraryImageBytes,
  libraryImageDigest,
  LIBRARY_IMAGE_PART_CHARS,
  LIBRARY_IMAGE_RESPONSE_BYTES,
} from "./library-image.ts";
import {
  LibraryExportAuthorization,
  LibraryObjectImage,
  LibraryObjectRef,
  LibraryRecoverySet,
  RecoveryDigest,
  RecoveryOperationId,
  RegisteredLibraryObject,
} from "./library-recovery-records.ts";
import {
  ArchiveNumber,
  LIBRARY_ARCHIVE_PAGE_SIZE,
  LIBRARY_ARCHIVE_RETENTION_MS,
  LibraryArchiveError,
  LibraryArchiveHeader,
  LibraryArchiveManifest,
  LibraryArchiveObject,
  LibraryArchiveUploadReceipt,
  LibraryRetainedArchiveJournal,
} from "./library-retained-archive-store.ts";
import { open, seal } from "./secrets.ts";

export const LIBRARY_ARCHIVE_OBJECT_BYTES = 256 * 1024;
const ZERO = "0".repeat(64);
const FORMAT = "kitties-library-archive-v1";
const unavailable = () => new LibraryArchiveError({ reason: "storage" });
const failed = (reason: LibraryArchiveError["reason"]) => new LibraryArchiveError({ reason });
const same = <A>(left: A, right: A) => JSON.stringify(left) === JSON.stringify(right);

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: S["Type"]) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => failed("invalid")),
  );

const hash = (body: string) => libraryImageDigest(body).pipe(Effect.mapError(unavailable));

export const LibraryArchiveRequest = Schema.Struct({
  archiveId: RecoveryOperationId,
  grantId: RecoveryOperationId,
  captureId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
});

export type LibraryArchiveRequest = typeof LibraryArchiveRequest.Type;

export const LibraryArchiveReadRequest = Schema.Struct({
  operationId: RecoveryOperationId,
  captureId: RecoveryOperationId,
  source: RegisteredLibraryObject,
  image: LibraryObjectImage,
  row: LibraryImagePart.fields.row,
  part: LibraryImagePart.fields.part,
});

export type LibraryArchiveReadRequest = typeof LibraryArchiveReadRequest.Type;

export const LibraryArchiveRestoreRequest = Schema.Struct({
  archiveId: RecoveryOperationId,
  restoreId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
});

export type LibraryArchiveRestoreRequest = typeof LibraryArchiveRestoreRequest.Type;

export interface LibraryArchiveRestoreSource {
  readonly read: (
    request: LibraryArchiveReadRequest,
  ) => Effect.Effect<LibraryImagePart, LibraryArchiveError>;
}

export class LibraryArchiveCaptureSource extends Context.Service<
  LibraryArchiveCaptureSource,
  {
    readonly recoverySet: (
      captureId: string,
    ) => Effect.Effect<LibraryRecoverySet, LibraryArchiveError>;
    readonly inventory: (
      captureId: string,
      after: number,
    ) => Effect.Effect<ReadonlyArray<RegisteredLibraryObject>, LibraryArchiveError>;
    readonly authorize: (
      grantId: string,
      captureId: string,
      ordinal: number,
    ) => Effect.Effect<LibraryExportAuthorization, LibraryArchiveError>;
    readonly read: (request: {
      readonly grantId: string;
      readonly captureId: string;
      readonly ordinal: number;
      readonly source: LibraryObjectRef;
      readonly image: LibraryObjectImage;
      readonly row: number;
      readonly part: number;
    }) => Effect.Effect<LibraryImagePart, LibraryArchiveError>;
  }
>()("@kitties/gateway/LibraryArchiveCaptureSource") {}

// This is the exact R2 API subset used here. The body needs only a published
// default reader, which also permits controlled Web Streams without faking R2.
interface LibraryArchiveR2 {
  readonly get: (key: string) => Promise<{
    readonly size: number;
    readonly uploaded: Date;
    readonly body: {
      readonly getReader: () => {
        readonly read: () => Promise<
          | { readonly done: true; readonly value?: unknown }
          | { readonly done: false; readonly value: Uint8Array }
        >;
        readonly cancel: () => Promise<void>;
        readonly releaseLock: () => void;
      };
    };
  } | null>;
  readonly put: (
    key: string,
    body: string,
    options: Cloudflare.R2PutOptions,
  ) => Promise<Cloudflare.R2Object | null>;
}

/** get must bound the actual streamed bytes, rather than trusting HEAD/size alone. */
export class LibraryArchiveObjects extends Context.Service<
  LibraryArchiveObjects,
  {
    readonly get: (
      key: string,
      maxBytes: number,
    ) => Effect.Effect<
      { readonly body: string; readonly uploadedAt: number } | null,
      LibraryArchiveError
    >;
    readonly putIfAbsent: (key: string, body: string) => Effect.Effect<void, LibraryArchiveError>;
  }
>()("@kitties/gateway/LibraryArchiveObjects") {
  static readonly layerR2 = (bucket: LibraryArchiveR2) =>
    Layer.succeed(
      LibraryArchiveObjects,
      LibraryArchiveObjects.of({
        get: (key, maxBytes) =>
          Effect.tryPromise({
            try: async (signal) => {
              // R2 get exposes no abort option for headers. If it resolves after
              // interruption, cancel the late body before any read/receipt.
              const value = await bucket.get(key);

              if (value === null) return null;

              const reader = value.body.getReader();
              const decoder = new TextDecoder("utf-8", { fatal: true });
              let bytes = 0;
              let body = "";
              let cancellation: Promise<void> | undefined;

              const cancel = () => {
                cancellation ??= reader.cancel();

                // Interruption already owns the outcome. Observe cleanup errors
                // without leaving an unhandled rejection or waiting indefinitely
                // for an underlying source's cancellation acknowledgement.
                void cancellation.catch(() => {});
              };

              signal.addEventListener("abort", cancel, { once: true });

              try {
                if (signal.aborted) throw failed("timeout");

                if (value.size > maxBytes) throw failed("limit");

                while (true) {
                  const chunk = await reader.read();

                  if (signal.aborted) throw failed("timeout");

                  if (chunk.done) break;
                  bytes += chunk.value.byteLength;

                  if (bytes > maxBytes) throw failed("limit");
                  body += decoder.decode(chunk.value, { stream: true });
                }

                body += decoder.decode();
              } finally {
                signal.removeEventListener("abort", cancel);

                try {
                  cancel();
                } finally {
                  reader.releaseLock();
                }
              }

              return { body, uploadedAt: value.uploaded.getTime() };
            },
            catch: (cause) => (Schema.is(LibraryArchiveError)(cause) ? cause : unavailable()),
          }),
        putIfAbsent: (key, body) =>
          Effect.tryPromise({
            try: () =>
              bucket.put(key, body, {
                onlyIf: { etagDoesNotMatch: "*" },
                httpMetadata: { contentType: "application/json" },
              }),
            catch: unavailable,
          }).pipe(Effect.asVoid),
      }),
    );
}

/** Only composition sees the KEK; callers/receipts/errors never contain it. */
export class LibraryArchiveKey extends Context.Service<
  LibraryArchiveKey,
  {
    readonly value: Redacted.Redacted<string>;
  }
>()("@kitties/gateway/LibraryArchiveKey") {}

export const LibraryArchivePolicy = Context.Reference<{
  readonly callMs: number;
  readonly uploadMs: number;
}>("@kitties/gateway/LibraryArchivePolicy", {
  defaultValue: () => ({ callMs: 10000, uploadMs: 120000 }),
});

const Envelope = Schema.Struct({
  kid: Schema.Literal("v1"),
  iv: Schema.String.check(Schema.isMaxLength(32)),
  ct: Schema.String.check(Schema.isMaxLength(LIBRARY_ARCHIVE_OBJECT_BYTES)),
});

const Part = Schema.Struct({
  format: Schema.Literal(FORMAT),
  archiveId: RecoveryOperationId,
  captureId: RecoveryOperationId,
  codeDigest: RecoveryDigest,
  ordinal: ArchiveNumber,
  source: LibraryObjectRef,
  image: LibraryObjectImage,
  value: LibraryImagePart,
});

const Page = Schema.Struct({
  format: Schema.Literal(FORMAT),
  archiveId: RecoveryOperationId,
  page: ArchiveNumber,
  previousSha256: RecoveryDigest,
  objects: Schema.Array(LibraryArchiveObject).check(Schema.isMaxLength(LIBRARY_ARCHIVE_PAGE_SIZE)),
});

const CapturedSet = Schema.Struct({ ...LibraryRecoverySet.fields, capturedAt: ArchiveNumber });
const prefix = (id: string) => `exports/library-v1/${id}`;

const partKey = (id: string, ordinal: number, row: number, part: number) =>
  `${prefix(id)}/parts/${ordinal}/${row}/${part}.json`;

const pageKey = (id: string, page: number) => `${prefix(id)}/metadata/${page}.json`;
const manifestKey = (id: string) => `${prefix(id)}/manifest.json`;

const makeArchive = Effect.gen(function* () {
  const source = yield* LibraryArchiveCaptureSource;
  const objects = yield* LibraryArchiveObjects;
  const journal = yield* LibraryRetainedArchiveJournal;
  const encryption = yield* LibraryArchiveKey;
  const policy = yield* LibraryArchivePolicy;

  const call = <A>(effect: Effect.Effect<A, LibraryArchiveError>) =>
    effect.pipe(Effect.timeoutOrElse({ duration: policy.callMs, orElse: () => failed("timeout") }));

  const bounded = (body: string) => libraryImageBytes(body) <= LIBRARY_ARCHIVE_OBJECT_BYTES;

  const read = Effect.fnUntraced(function* <S extends Schema.ConstraintDecoder<unknown>>(
    key: string,
    schema: S,
    expected: LibraryArchiveUploadReceipt | null,
  ) {
    const stored = yield* call(objects.get(key, LIBRARY_ARCHIVE_OBJECT_BYTES));

    if (stored === null) return yield* failed("incomplete");

    if (!bounded(stored.body)) return yield* failed("limit");

    const encrypted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope), {
      onExcessProperty: "error",
    })(stored.body).pipe(Effect.mapError(() => failed("invalid")));

    const cipherSha256 = yield* hash(stored.body);

    if (
      expected !== null &&
      (cipherSha256 !== expected.cipherSha256 || stored.uploadedAt !== expected.uploadedAt)
    )
      return yield* failed("conflict");

    const plaintext = yield* call(
      Effect.tryPromise({
        try: () => open(Redacted.value(encryption.value), `${FORMAT}:${key}`, encrypted),
        catch: () => failed("conflict"),
      }),
    );

    if (!bounded(plaintext)) return yield* failed("limit");

    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
      onExcessProperty: "error",
    })(plaintext).pipe(Effect.mapError(() => failed("invalid")));

    const plainSha256 = yield* hash(plaintext);

    if (
      expected !== null &&
      (plainSha256 !== expected.plainSha256 || libraryImageBytes(stored.body) !== expected.bytes)
    )
      return yield* failed("conflict");
    const verifiedAt = yield* Clock.currentTimeMillis;

    const receipt = yield* decode(LibraryArchiveUploadReceipt, {
      plainSha256,
      cipherSha256,
      uploadedAt: stored.uploadedAt,
      bytes: libraryImageBytes(stored.body),
      verifiedAt,
    });

    if (receipt.uploadedAt > verifiedAt) return yield* failed("conflict");

    return { value, receipt };
  });

  const write = Effect.fnUntraced(function* <S extends Schema.ConstraintDecoder<unknown>>(
    key: string,
    schema: S,
    value: S["Type"],
  ) {
    // A crash may occur after PUT and before journal ACK. Existing/randomized
    // ciphertext is accepted only after authenticated semantic comparison.
    const previous = yield* call(objects.get(key, LIBRARY_ARCHIVE_OBJECT_BYTES));

    if (previous === null) {
      const plaintext = JSON.stringify(value);

      if (!bounded(plaintext)) return yield* failed("limit");

      const envelope = yield* call(
        Effect.tryPromise({
          try: () => seal(Redacted.value(encryption.value), `${FORMAT}:${key}`, plaintext),
          catch: unavailable,
        }),
      );

      const body = JSON.stringify(envelope);

      if (!bounded(body)) return yield* failed("limit");
      yield* call(objects.putIfAbsent(key, body));
    }

    // Re-read the winning object even after a conditional race; proposed bytes
    // are not a receipt and HEAD never establishes authenticity/completeness.
    const winner = yield* read(key, schema, null);

    if (!same(winner.value, value)) return yield* failed("conflict");

    return winner;
  });

  const begin = Effect.fnUntraced(function* (input: LibraryArchiveRequest) {
    const request = yield* decode(LibraryArchiveRequest, input);
    const previous = yield* journal.status(request.archiveId);

    if (previous !== null) {
      if (
        previous.header.grantId !== request.grantId ||
        previous.header.set.id !== request.captureId ||
        previous.header.set.codeDigest !== request.codeDigest
      )
        return yield* failed("conflict");

      return previous;
    }

    const captured = yield* call(source.recoverySet(request.captureId));

    const selected = yield* Schema.decodeUnknownEffect(CapturedSet)(captured).pipe(
      Effect.mapError(() => failed("invalid")),
    );

    if (selected.id !== request.captureId || selected.codeDigest !== request.codeDigest)
      return yield* failed("conflict");

    if (selected.capturedAt > (yield* Clock.currentTimeMillis)) return yield* failed("invalid");

    return yield* journal.begin(
      LibraryArchiveHeader.make({
        archiveId: request.archiveId,
        grantId: request.grantId,
        set: captured,
        capturedAt: selected.capturedAt,
      }),
    );
  });

  const expectedPart = (
    header: LibraryArchiveHeader,
    object: LibraryArchiveObject,
    value: LibraryImagePart,
  ) =>
    Part.make({
      format: FORMAT,
      archiveId: header.archiveId,
      captureId: header.set.id,
      codeDigest: header.set.codeDigest,
      ordinal: object.ordinal,
      source: object.source,
      image: object.image,
      value,
    });

  const validatePart = (value: LibraryImagePart, row: number, part: number) => {
    const count = Math.ceil(value.chars / LIBRARY_IMAGE_PART_CHARS);
    const chars = Math.min(LIBRARY_IMAGE_PART_CHARS, value.chars - part * LIBRARY_IMAGE_PART_CHARS);

    return (
      value.row === row &&
      value.part === part &&
      value.parts === count &&
      value.chunk.length === chars &&
      libraryImageBytes(JSON.stringify(value)) <= LIBRARY_IMAGE_RESPONSE_BYTES
    );
  };

  const upload = Effect.fnUntraced(
    function* (input: LibraryArchiveRequest) {
      const initial = yield* begin(input);

      if (initial.phase === "committed") return initial;
      const header = initial.header;
      let after = 0;
      let objectCount = 0;

      while (true) {
        const members = yield* call(source.inventory(header.set.id, after));

        if (members.length > 64) return yield* failed("limit");

        if (members.length === 0) break;

        for (const member of members) {
          const selected = yield* Schema.decodeUnknownEffect(RegisteredLibraryObject)(member).pipe(
            Effect.mapError(() => failed("invalid")),
          );

          if (selected.ordinal <= after || selected.lineage !== header.set.sourceLineage)
            return yield* failed("conflict");

          const authorization = yield* call(
            source.authorize(header.grantId, header.set.id, selected.ordinal),
          );

          const authorized = yield* decode(LibraryExportAuthorization, authorization);
          const ref = Schema.decodeUnknownSync(LibraryObjectRef)(selected);

          if (
            authorized.captureId !== header.set.id ||
            authorized.ordinal !== selected.ordinal ||
            !same(authorized.source, ref)
          )
            return yield* failed("conflict");

          const object = yield* journal.recordObject(header.archiveId, {
            ordinal: selected.ordinal,
            source: authorized.source,
            image: authorized.image,
          });

          objectCount++;

          if (objectCount > header.set.objectCount) return yield* failed("conflict");

          if (!object.complete) {
            let chain = yield* hash("kitties-library-image-v1");
            const rowCount = authorized.image.kvCount + authorized.image.sqlCount + 1;

            if (!Number.isSafeInteger(rowCount)) return yield* failed("limit");

            for (let row = 1; row <= rowCount; row++) {
              let parts = 1;
              let body = "";
              let rowPart: LibraryImagePart | undefined;

              for (let part = 0; part < parts; part++) {
                const previous = yield* journal.part(header.archiveId, object.ordinal, row, part);
                let value: LibraryImagePart;

                if (previous !== null) {
                  const retained = yield* read(
                    partKey(header.archiveId, object.ordinal, row, part),
                    Part,
                    previous,
                  );

                  value = retained.value.value;

                  if (!same(retained.value, expectedPart(header, object, value)))
                    return yield* failed("conflict");
                } else {
                  value = yield* call(
                    source.read({
                      grantId: header.grantId,
                      captureId: header.set.id,
                      ordinal: object.ordinal,
                      source: object.source,
                      image: object.image,
                      row,
                      part,
                    }),
                  );
                  value = yield* decode(LibraryImagePart, value);

                  if (!validatePart(value, row, part)) return yield* failed("conflict");

                  const stored = yield* write(
                    partKey(header.archiveId, object.ordinal, row, part),
                    Part,
                    expectedPart(header, object, value),
                  );

                  yield* journal.recordPart(header.archiveId, object.ordinal, {
                    ...stored.receipt,
                    row,
                    part,
                    parts: value.parts,
                  });
                }

                if (!validatePart(value, row, part)) return yield* failed("conflict");

                if (
                  rowPart !== undefined &&
                  (rowPart.parts !== value.parts ||
                    rowPart.chars !== value.chars ||
                    rowPart.digest !== value.digest ||
                    rowPart.kind !== value.kind ||
                    rowPart.key !== value.key)
                )
                  return yield* failed("conflict");
                rowPart = value;
                parts = value.parts;
                body += value.chunk;
              }

              if (
                rowPart === undefined ||
                body.length !== rowPart.chars ||
                (yield* hash(body)) !== rowPart.digest
              )
                return yield* failed("conflict");
              chain = yield* hash(`${chain}\n${rowPart.kind}\n${rowPart.key}\n${rowPart.digest}`);
            }

            if (chain !== object.image.digest) return yield* failed("conflict");
            yield* journal.completeObject(header.archiveId, object.ordinal);
          }

          after = selected.ordinal;
        }
      }

      if (objectCount !== header.set.objectCount) return yield* failed("incomplete");
      let page = 0;
      let pageAfter = 0;
      let previousSha256 = ZERO;

      while (true) {
        const members = yield* journal.objects(header.archiveId, pageAfter);

        if (members.length === 0 && page > 0) break;

        const expected = Page.make({
          format: FORMAT,
          archiveId: header.archiveId,
          page,
          previousSha256,
          objects: members,
        });

        const previous = yield* journal.page(header.archiveId, page);

        const stored =
          previous === null
            ? yield* write(pageKey(header.archiveId, page), Page, expected)
            : yield* read(pageKey(header.archiveId, page), Page, previous);

        if (!same(stored.value, expected)) return yield* failed("conflict");
        pageAfter = members.at(-1)?.ordinal ?? 0;

        if (previous === null)
          yield* journal.recordPage(header.archiveId, {
            ...stored.receipt,
            page,
            after: pageAfter,
            count: members.length,
            previousSha256,
          });
        previousSha256 = stored.receipt.plainSha256;
        page++;
      }

      const status = yield* journal.status(header.archiveId);

      if (status === null) return yield* failed("incomplete");
      const now = yield* Clock.currentTimeMillis;
      const oldestUploadedAt = status.oldestUploadedAt ?? now;
      const expiresAt = oldestUploadedAt + LIBRARY_ARCHIVE_RETENTION_MS;

      if (!Number.isSafeInteger(expiresAt)) return yield* failed("limit");

      if (now >= expiresAt) return yield* failed("expired");

      const manifest = LibraryArchiveManifest.make({
        format: FORMAT,
        header,
        objectCount,
        partCount: status.partCount,
        pageCount: page,
        lastPageSha256: previousSha256,
        oldestUploadedAt,
        expiresAt,
      });

      const stored = yield* write(manifestKey(header.archiveId), LibraryArchiveManifest, manifest);

      return yield* journal.commit(
        header.archiveId,
        { manifest: stored.value, receipt: stored.receipt },
        yield* Clock.currentTimeMillis,
      );
    },
    Effect.timeoutOrElse({ duration: policy.uploadMs, orElse: () => failed("timeout") }),
  );

  const retainedSource = Effect.fnUntraced(function* (input: LibraryArchiveRestoreRequest) {
    const request = yield* decode(LibraryArchiveRestoreRequest, input);
    const status = yield* journal.status(request.archiveId);

    if (status === null || status.commit === null) return yield* failed("incomplete");

    if (status.header.set.codeDigest !== request.codeDigest) return yield* failed("conflict");
    yield* journal.pinRestore(request.restoreId, request.archiveId, yield* Clock.currentTimeMillis);

    const manifest = yield* read(
      manifestKey(request.archiveId),
      LibraryArchiveManifest,
      status.commit.receipt,
    );

    if (!same(manifest.value, status.commit.manifest)) return yield* failed("conflict");

    const readPart = Effect.fnUntraced(function* (input: LibraryArchiveReadRequest) {
      const selected = yield* decode(LibraryArchiveReadRequest, input);
      const pin = yield* journal.restorePin(request.restoreId);

      if (
        pin === null ||
        pin.completed ||
        pin.archiveId !== request.archiveId ||
        selected.operationId !== request.restoreId ||
        selected.captureId !== status.header.set.id
      )
        return yield* failed("conflict");

      if (status.expiresAt === null || (yield* Clock.currentTimeMillis) >= status.expiresAt)
        return yield* failed("expired");
      const object = yield* journal.object(request.archiveId, selected.source.ordinal);
      const ref = Schema.decodeUnknownSync(LibraryObjectRef)(selected.source);

      if (
        object === null ||
        !object.complete ||
        !same(object.source, ref) ||
        !same(object.image, selected.image)
      )
        return yield* failed("conflict");

      const receipt = yield* journal.part(
        request.archiveId,
        object.ordinal,
        selected.row,
        selected.part,
      );

      if (receipt === null) return yield* failed("incomplete");

      const stored = yield* read(
        partKey(request.archiveId, object.ordinal, selected.row, selected.part),
        Part,
        receipt,
      );

      if (
        !same(stored.value, expectedPart(status.header, object, stored.value.value)) ||
        !validatePart(stored.value.value, selected.row, selected.part)
      )
        return yield* failed("conflict");

      return stored.value.value;
    });

    return { read: readPart } satisfies LibraryArchiveRestoreSource;
  });

  return {
    begin,
    status: journal.status,
    upload,
    retainedSource,
    finishRestore: journal.finishRestore,
  };
});

/** Bounded encrypted capture upload and explicit retained-only restore source. */
export class LibraryRetainedArchive extends Context.Service<
  LibraryRetainedArchive,
  Effect.Success<typeof makeArchive>
>()("@kitties/gateway/LibraryRetainedArchive") {
  static readonly layer = Layer.effect(LibraryRetainedArchive, makeArchive);
}
