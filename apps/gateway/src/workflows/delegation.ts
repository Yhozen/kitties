import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { HomeDO, ChatDO } from "../actors.ts";
import { Delegation } from "../delegation-definition.ts";
import { Turn } from "../turn-definition.ts";
import { DelegateInput } from "../autonomy-tools.ts";
import { sha256 } from "../kitty.ts";
const storage = () => "STORAGE_UNAVAILABLE";
export const DelegationLive = Workflows.layer(
  Delegation,
  Effect.gen(function* () {
    const homes = yield* HomeDO,
      chats = yield* ChatDO;
    return Effect.fn(function* (payload) {
      const home = homes.getByName("owner", { locationHint: "weur" }),
        parent = chats.getByName(payload.chatId, { locationHint: "weur" });
      const keys = yield* Activity.make({
        name: "plan",
        success: Schema.Array(Schema.String),
        error: Schema.String,
        execute: Effect.gen(function* () {
          if (payload.depth >= 2) return yield* Effect.fail("DELEGATION_DEPTH");
          if (
            (yield* parent.run(payload.messageId).pipe(Effect.mapError(storage)))?.status ===
            "cancelled"
          )
            return [];
          const raw = yield* home.read("delegation-job", payload.id).pipe(Effect.mapError(storage));
          if (!raw) return yield* Effect.fail("DELEGATION_NOT_FOUND");
          const job = yield* Schema.decodeUnknownEffect(DelegateInput)(JSON.parse(raw)).pipe(
            Effect.mapError(() => "INVALID_ARGUMENTS"),
          );
          const keys: string[] = [];
          for (let index = 0; index < job.tasks.length; index++) {
            const task = job.tasks[index]!;
            if (
              task.kittyId === payload.kittyId ||
              !(yield* home.read("kitty", task.kittyId).pipe(Effect.mapError(storage)))
            )
              return yield* Effect.fail("DELEGATION_TARGET");
            const key = yield* Effect.promise(() => sha256(`${payload.id}:${index}`));
            const child = {
              chatId: `delegation-${key}`,
              messageId: key,
              kittyId: task.kittyId,
              text: task.instruction,
              depth: payload.depth + 1,
            };
            yield* home
              .insert(
                "delegation-child",
                key,
                JSON.stringify({
                  ...child,
                  parentChatId: payload.chatId,
                  parentMessageId: payload.messageId,
                }),
              )
              .pipe(Effect.mapError(storage));
            yield* home
              .insert(
                "chat",
                child.chatId,
                JSON.stringify({
                  id: child.chatId,
                  title: `Delegation ${index + 1}`,
                  members: [task.kittyId],
                  createdAt: Date.now(),
                  parentChatId: payload.chatId,
                  depth: child.depth,
                }),
              )
              .pipe(Effect.mapError(storage));
            keys.push(key);
          }
          return keys;
        }),
      });
      const children: (typeof Turn.payloadSchema.Type)[] = [];
      for (const key of keys) {
        const raw = yield* home.read("delegation-child", key).pipe(Effect.mapError(storage));
        if (!raw) return yield* Effect.fail("DELEGATION_NOT_FOUND");
        children.push(JSON.parse(raw) as typeof Turn.payloadSchema.Type);
      }
      // Persist every start before joining any child. Replay never changes the fan-out set.
      const started = yield* Effect.all(
        children.map((child, index) =>
          Activity.make({
            name: `start/${index}`,
            success: Schema.String,
            error: Schema.String,
            execute: Effect.gen(function* () {
              if (
                (yield* parent.run(payload.messageId).pipe(Effect.mapError(storage)))?.status ===
                "cancelled"
              )
                return "";
              const queued = yield* chats
                .getByName(child.chatId, { locationHint: "weur" })
                .enqueue(child, false)
                .pipe(Effect.mapError(storage));
              if (queued.cancelled) return "";
              return yield* Turn.execute(child, { discard: true });
            }),
          }),
        ),
        { concurrency: "unbounded" },
      );
      for (let index = 0; index < children.length; index++)
        if (started[index]) yield* Turn.execute(children[index]!);
      yield* Activity.make({
        name: "collect",
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function* () {
          const results = [];
          for (const child of children) {
            const row = yield* chats
              .getByName(child.chatId, { locationHint: "weur" })
              .run(child.messageId)
              .pipe(Effect.mapError(storage));
            results.push({
              kittyId: child.kittyId,
              chatId: child.chatId,
              answer: row?.answer.slice(0, 12000) ?? "",
              status: row?.status ?? "unknown",
            });
          }
          yield* parent
            .saveToolResult(
              payload.messageId,
              payload.callId,
              JSON.stringify({
                isFailure: false,
                result: { delegations: results, untrusted: true },
              }),
            )
            .pipe(Effect.mapError(storage));
          yield* home
            .insert(
              "kitty-journal",
              payload.id,
              JSON.stringify({
                id: payload.id,
                kittyId: payload.kittyId,
                kind: "delegation",
                chatId: payload.chatId,
                children: children.map((child) => child.chatId),
                at: Date.now(),
              }),
            )
            .pipe(Effect.mapError(storage));
          return payload.callId;
        }),
      });
      return payload.callId;
    });
  }),
);
