import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { LibraryRecoveryError } from "./library-recovery-records.ts";
import type { LibraryArchiveError } from "./library-retained-archive-store.ts";

const response = (error: LibraryRecoveryError | LibraryArchiveError) => {
  const status = Match.value(error.reason).pipe(
    Match.when("invalid", () => 400),
    Match.when("expired", () => 410),
    Match.when("limit", () => 413),
    Match.whenOr("storage", "timeout", () => 503),
    Match.whenOr("conflict", "fenced", "incomplete", "uninitialized", "exhausted", () => 409),
    Match.exhaustive,
  );

  return Effect.succeed(
    HttpServerResponse.fromWeb(
      Response.json(
        { code: `LIBRARY_${error.reason.toUpperCase()}`, params: {} },
        { status, headers: { "Cache-Control": "no-store" } },
      ),
    ),
  );
};

/** Only expected Library failures are translated at the owner recovery route. */
export const libraryRecoveryFailures = {
  LibraryRecoveryError: response,
  LibraryArchiveError: response,
};
