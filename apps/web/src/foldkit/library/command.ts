import { LibraryApi } from "@kitties/domain/LibraryApi.api";
import { LibraryUnauthorized } from "@kitties/domain/LibrarySession.middleware";
import { LibraryImportRequired } from "@kitties/domain/Library/Library.rejection";
import { SkillDetailKey } from "@kitties/domain/Library/Skill.id";
import { LibraryVersion } from "@kitties/domain/Library/Skill";
import { Cause, Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { LibraryClientAuthentication, LibraryClientScope } from "./LibraryClientAuthentication.ts";
import { Message } from "./message.ts";
import { ReadProblem, Receipt } from "./model.ts";

export const readProblem = (cause: unknown): ReadProblem => {
  const decoded = Schema.decodeUnknownOption(
    Schema.Union([LibraryUnauthorized, LibraryImportRequired]),
  )(cause);

  return Option.match(decoded, {
    onNone: () => "Unavailable",
    onSome: (failure) => (Schema.is(LibraryUnauthorized)(failure) ? "Authentication" : "NotReady"),
  });
};

export const ReadSkillDetail = Command.define("ReadSkillDetail", {
  args: { key: SkillDetailKey, generation: LibraryVersion, maybeAtLeast: Schema.Option(Receipt) },
  messages: [Message.SucceededReadSkillDetail, Message.FailedReadSkillDetail],
  execute: ({ key, generation, maybeAtLeast }) =>
    Effect.gen(function* () {
      const api = yield* LibraryApi.Client;

      const state = yield* api.SkillDetail.get(key, {
        atLeast: Option.getOrUndefined(maybeAtLeast),
      });

      return Message.SucceededReadSkillDetail({ key, generation, state });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedReadSkillDetail({
            key,
            generation,
            problem: readProblem(error),
          }),
        ),
      ),
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.succeed(Message.FailedReadSkillDetail({ key, generation, problem: "Unavailable" })),
      ),
    ),
});

export const ReauthenticateLibrary = Command.define("ReauthenticateLibrary", {
  args: { scope: LibraryClientScope, attempt: LibraryVersion },
  messages: [Message.SucceededReauthenticateLibrary, Message.FailedReauthenticateLibrary],
  execute: ({ scope, attempt }) =>
    Effect.gen(function* () {
      const authentication = yield* LibraryClientAuthentication;

      yield* authentication.reauthenticate(scope);

      return Message.SucceededReauthenticateLibrary({ attempt });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(Message.FailedReauthenticateLibrary({ attempt, reason: error.reason })),
      ),
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.succeed(Message.FailedReauthenticateLibrary({ attempt, reason: "Unavailable" })),
      ),
    ),
});
