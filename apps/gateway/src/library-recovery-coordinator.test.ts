import { DatabaseSync } from "node:sqlite";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { LibraryModel } from "@kitties/domain/Library.model";
import { it } from "@effect/vitest";
import { Context, Data, Deferred, Effect, Fiber, Layer, Match, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { LibraryControl } from "./library-control.ts";
import { LibraryAdminStatus, type LibraryAdminReply } from "./library-object-admin.ts";
import { GlobalRecoveryAuthority } from "./library-recovery-authority.ts";
import {
  LibraryRecoveryCoordinator,
  LibraryRecoveryPolicy,
  LibraryRestoreParts,
} from "./library-recovery-coordinator.ts";
import { LibraryObjectAdministration } from "./library-recovery-host.ts";
import { LibraryObjectRef, LibraryRecoveryError } from "./library-recovery-records.ts";
import { LibraryRecoveryStore, type LibraryControlDatabase } from "./library-recovery-store.ts";

const Reply = Data.taggedEnum<LibraryAdminReply>();
const codeDigest = "a".repeat(64);
const image = { digest: "b".repeat(64), kvCount: 2, sqlCount: 1 };

const fixture = (pause: "capture" | "resume" = "resume") =>
  Effect.gen(function* () {
    const sql = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(":memory:")),
      (database) => Effect.sync(() => database.close()),
    );

    const database: LibraryControlDatabase = {
      query: (statement, ...bindings) =>
        Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject))(
          sql.prepare(statement).all(...bindings),
        ),
      transaction: (body) => {
        sql.exec("BEGIN IMMEDIATE");

        try {
          const result = body();
          sql.exec("COMMIT");

          return result;
        } catch (cause) {
          sql.exec("ROLLBACK");
          throw cause;
        }
      },
    };

    sql.exec(
      "CREATE TABLE recovery_control (id INTEGER PRIMARY KEY,epoch INTEGER,operation_id TEXT,mode TEXT)",
    );
    sql.exec("INSERT INTO recovery_control VALUES (1,7,NULL,'ready')");
    sql.exec("CREATE TABLE recovery_runs (workflow TEXT,id TEXT,epoch INTEGER,review INTEGER)");
    sql.exec("INSERT INTO recovery_runs VALUES ('Export','previously-admitted',7,0)");

    const authority = yield* GlobalRecoveryAuthority.pipe(
      Effect.provide(GlobalRecoveryAuthority.layer(database, () => 100)),
    );

    const store = yield* LibraryRecoveryStore.pipe(
      Effect.provide(LibraryRecoveryStore.layer(database, authority)),
    );

    yield* store.initialize("inventory");

    const source = LibraryObjectRef.make({
      modelName: "LibraryModel",
      layout: 0,
      className: "LibraryModel.LibraryAggregate",
      lineage: "library-1",
      logicalName: "owner",
      physicalName: "r:library-1:owner",
      nativeId: "1".repeat(64),
    });

    const ordinal = yield* store.register(source);
    yield* store.finishImport("inventory", 3);
    const reachedCapture = yield* Deferred.make<void>();
    const captureDelivery = yield* Deferred.make<void>();
    const reachedResume = yield* Deferred.make<void>();
    const resumeDelivery = yield* Deferred.make<void>();
    let generation = 0;
    let before: string | null = null;
    let resuming: string | null = null;
    let captures = 0;

    const status = () =>
      LibraryAdminStatus.make({
        nonce: `constructor-${generation}`,
        before,
        resuming,
        activating: null,
        initialized: resuming !== null && resuming !== `constructor-${generation}`,
        mode: resuming === null ? "frozen" : "active",
        ordinal,
        outboxPending: false,
        outboxWake: false,
        backfillPending: false,
        backfillWake: false,
        held: resuming === null,
      });

    // This port exercises coordinator ordering and timeouts. Native constructor,
    // scheduler and image fidelity are separate real-workerd gates.
    const administration = LibraryObjectAdministration.of({
      derive: (className, lineage, logicalName) =>
        Effect.succeed({
          ...source,
          className,
          lineage,
          logicalName,
          physicalName: `r:${lineage}:${logicalName}`,
          nativeId: "2".repeat(64),
        }),
      call: (_ref, request) =>
        Match.value(request).pipe(
          Match.tag("Freeze", () =>
            Effect.sync(() => {
              before ??= status().nonce;

              return Reply.Status({ value: status() });
            }),
          ),
          Match.tag("Evict", () =>
            Effect.sync(() => {
              generation++;

              return Reply.Acknowledged();
            }),
          ),
          Match.tag("VerifyFrozen", () => Effect.succeed(Reply.Status({ value: status() }))),
          Match.tag("ReadAllocatorFloor", () => Effect.succeed(Reply.AllocatorFloor({ value: 9 }))),
          Match.tag("CaptureStep", () =>
            Effect.gen(function* () {
              captures++;
              yield* Deferred.succeed(reachedCapture, undefined);

              if (pause === "capture") yield* Deferred.await(captureDelivery);

              return Reply.Progress({ value: { done: true, image } });
            }),
          ),
          Match.tag("BeginLoad", () => Effect.succeed(Reply.Acknowledged())),
          Match.tag("ResumeCapture", () =>
            Effect.sync(() => {
              resuming ??= status().nonce;

              return Reply.Status({ value: status() });
            }),
          ),
          Match.tag("VerifyResumed", () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reachedResume, undefined);
              yield* Deferred.await(resumeDelivery);

              return status().initialized
                ? Reply.Status({ value: status() })
                : Reply.Rejected({ reason: "incomplete" });
            }),
          ),
          Match.orElse(() => Effect.die("Unexpected capture administration request")),
        ),
    });

    const control = Layer.succeed(LibraryControl, {
      ...store,
      complete: () => Effect.void,
      completePublication: () => Effect.void,
    });

    const model = LibraryModel.layer(Layer.empty).pipe(
      Layer.provide(InMemory.make({ manual: true }).layer),
    );

    const layers = Layer.mergeAll(
      control,
      model,
      Layer.succeed(LibraryObjectAdministration, administration),
    );

    const restart = Effect.gen(function* () {
      const context = yield* Layer.build(
        LibraryRecoveryCoordinator.layer.pipe(Layer.provide(layers)),
      ).pipe(Effect.provideService(LibraryRecoveryPolicy, { callMs: 50, totalMs: 1000 }));

      return Context.get(context, LibraryRecoveryCoordinator);
    });

    return {
      store,
      ordinal,
      restart,
      reachedCapture,
      captureDelivery,
      reachedResume,
      resumeDelivery,
      captures: () => captures,
      global: () => database.query("SELECT * FROM recovery_control"),
      runs: () => database.query("SELECT * FROM recovery_runs"),
    };
  });

it.effect(
  "a timed-out fresh resume keeps admission closed; same-ID retry reopens without changing workflow authority",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const coordinator = yield* f.restart;

      const first = yield* coordinator
        .capture({ operationId: "backup", codeDigest })
        .pipe(Effect.forkChild);

      yield* Deferred.await(f.reachedResume);
      yield* TestClock.adjust(51);
      expect(yield* Effect.flip(Fiber.join(first))).toEqual(
        new LibraryRecoveryError({ reason: "storage" }),
      );
      expect(yield* f.store.status).toMatchObject({
        phase: "resuming",
        lineage: "library-1",
        epoch: 1,
        allocatorFloor: 9,
      });
      expect(yield* Effect.flip(f.store.admit(1))).toEqual(
        new LibraryRecoveryError({ reason: "fenced" }),
      );
      expect(yield* f.store.resumeProgress("backup", f.ordinal)).toEqual({
        before: "constructor-1",
        after: null,
      });
      expect(f.global()).toEqual([{ id: 1, epoch: 7, operation_id: null, mode: "ready" }]);
      expect(f.runs()).toEqual([
        { workflow: "Export", id: "previously-admitted", epoch: 7, review: 0 },
      ]);
      yield* Deferred.succeed(f.resumeDelivery, undefined);
      const restarted = yield* f.restart;
      const captured = yield* restarted.capture({ operationId: "backup", codeDigest });
      expect(captured).toMatchObject({
        id: "backup",
        sourceLineage: "library-1",
        objectCount: 1,
        allocatorFloor: 9,
      });
      expect(yield* f.store.admit(1)).toMatchObject({ lineage: "library-1", epoch: 1 });
      expect(yield* f.store.resumeProgress("backup", f.ordinal)).toEqual({
        before: "constructor-1",
        after: "constructor-2",
      });
      expect(f.captures()).toBe(1);

      yield* f.store.beginCapture("next-backup", codeDigest);
      expect(yield* restarted.capture({ operationId: "backup", codeDigest })).toEqual(captured);
      expect(yield* f.store.status).toMatchObject({ phase: "frozen", operationId: "next-backup" });
      expect(
        yield* Effect.flip(
          restarted.capture({ operationId: "backup", codeDigest: "c".repeat(64) }),
        ),
      ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
      expect(f.captures()).toBe(1);
    }),
);

it.effect("a timed-out capture binds its original code digest before any retried image read", () =>
  Effect.gen(function* () {
    const f = yield* fixture("capture");
    const coordinator = yield* f.restart;

    const first = yield* coordinator
      .capture({ operationId: "partial", codeDigest })
      .pipe(Effect.forkChild);

    yield* Deferred.await(f.reachedCapture);
    yield* TestClock.adjust(51);
    expect(yield* Effect.flip(Fiber.join(first))).toEqual(
      new LibraryRecoveryError({ reason: "storage" }),
    );
    expect(yield* f.store.recoverySet("partial")).toBeNull();
    expect(f.captures()).toBe(1);
    expect(
      yield* Effect.flip(
        coordinator.capture({ operationId: "partial", codeDigest: "c".repeat(64) }),
      ),
    ).toEqual(new LibraryRecoveryError({ reason: "conflict" }));
    expect(f.captures()).toBe(1);
    yield* Deferred.succeed(f.captureDelivery, undefined);
    yield* Deferred.succeed(f.resumeDelivery, undefined);
    expect(yield* coordinator.capture({ operationId: "partial", codeDigest })).toMatchObject({
      id: "partial",
      codeDigest,
    });
    expect(yield* f.store.admit(1)).toMatchObject({ lineage: "library-1", epoch: 1 });
  }),
);

it.effect(
  "a retained read storage failure stays retryable and never falls back to a native part",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const coordinator = yield* f.restart;
      yield* Deferred.succeed(f.resumeDelivery, undefined);
      yield* coordinator.capture({ operationId: "retained", codeDigest });
      let readCount = 0;

      const outcome = yield* Effect.flip(
        coordinator.restore({ operationId: "restore", setId: "retained", codeDigest }).pipe(
          Effect.provideService(LibraryRestoreParts, {
            identity: { archiveId: "archive", manifestDigest: "e".repeat(64) },
            read: () =>
              Effect.suspend(() => {
                readCount++;

                return Effect.fail(new LibraryRecoveryError({ reason: "storage" }));
              }),
          }),
        ),
      );

      expect(outcome).toEqual(new LibraryRecoveryError({ reason: "storage" }));
      expect(readCount).toBe(1);
      expect(yield* f.store.status).toMatchObject({
        phase: "staging",
        operationId: "restore",
        lineage: "library-1",
        stagingLineage: "library-2",
      });
      expect(yield* f.store.publication("restore", "retained", codeDigest)).toBeNull();
    }),
);
