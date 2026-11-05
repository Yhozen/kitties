import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { expect } from "vite-plus/test";
import { libraryRecoveryFailures } from "./library-recovery-http.ts";
import { LibraryRecoveryError } from "./library-recovery-records.ts";
import { LibraryArchiveError } from "./library-retained-archive-store.ts";

it.effect(
  "owner recovery responses distinguish conflicts, expiry and retryable storage failures",
  () =>
    Effect.gen(function* () {
      const cases = [
        {
          error: new LibraryRecoveryError({ reason: "conflict" }),
          status: 409,
          code: "LIBRARY_CONFLICT",
        },
        {
          error: new LibraryRecoveryError({ reason: "fenced" }),
          status: 409,
          code: "LIBRARY_FENCED",
        },
        {
          error: new LibraryRecoveryError({ reason: "storage" }),
          status: 503,
          code: "LIBRARY_STORAGE",
        },
        {
          error: new LibraryArchiveError({ reason: "expired" }),
          status: 410,
          code: "LIBRARY_EXPIRED",
        },
        {
          error: new LibraryArchiveError({ reason: "timeout" }),
          status: 503,
          code: "LIBRARY_TIMEOUT",
        },
        {
          error: new LibraryArchiveError({ reason: "invalid" }),
          status: 400,
          code: "LIBRARY_INVALID",
        },
        { error: new LibraryArchiveError({ reason: "limit" }), status: 413, code: "LIBRARY_LIMIT" },
      ];

      for (const entry of cases) {
        const result = yield* Effect.fail(entry.error).pipe(
          Effect.catchTags(libraryRecoveryFailures),
        );

        const response = HttpServerResponse.toWeb(result);
        expect(response.status).toBe(entry.status);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.text())).toBe(
          JSON.stringify({ code: entry.code, params: {} }),
        );
      }
    }),
);
