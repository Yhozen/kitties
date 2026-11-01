import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { HomeDO, ChatDO } from "./actors.ts";
import { GoalInput, HookInput, RuleInput, type Goal } from "./entities.ts";
import { GoalSlot } from "./goal-definition.ts";
import { nextSlot } from "./schedule.ts";
import { readBody } from "./request.ts";
import { seal } from "./secrets.ts";
const json = (value: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } }),
  );
export const makeAutonomy = Effect.gen(function* () {
  const homes = yield* HomeDO,
    chats = yield* ChatDO,
    slots = yield* Workflows.RunWorkflow(GoalSlot);
  const env = (yield* Cloudflare.WorkerEnvironment) as { KITTIES_KEK: string };
  const tick = Effect.gen(function* () {
    const home = homes.getByName("owner", { locationHint: "weur" });
    yield* Effect.forEach(
      yield* home.list("goal"),
      (row) =>
        Effect.gen(function* () {
          const goal = JSON.parse(row.body) as Goal;
          if (goal.enabled)
            yield* slots.start({
              goalId: goal.id,
              revision: goal.revision,
              slotTime: goal.nextSlot,
            });
        }).pipe(Effect.catchCause(() => Effect.logError("Goal reconciliation will retry"))),
      { concurrency: 4 },
    );
  });
  const route = (request: Request) =>
    Effect.gen(function* () {
      const home = homes.getByName("owner", { locationHint: "weur" }),
        path = new URL(request.url).pathname,
        method = request.method;
      if (path === "/v1/approval-rules" && method === "GET")
        return json((yield* home.list("approval-rule")).map((row) => JSON.parse(row.body)));
      if (path === "/v1/approval-rules" && method === "PUT") {
        const body = yield* readBody(request, RuleInput),
          id = JSON.stringify([body.kittyId, body.connectionId, body.action]);
        const rule = { ...body, id };
        yield* home.write("approval-rule", id, JSON.stringify(rule));
        return json(rule);
      }
      const ruleRoute = path.match(/^\/v1\/approval-rules\/([^/]+)$/);
      if (ruleRoute && method === "DELETE") {
        const id = decodeURIComponent(ruleRoute[1]!);
        yield* home.remove("approval-rule", id);
        yield* home.remove("approval-trust", id);
        return HttpServerResponse.empty({ status: 204 });
      }
      if (path === "/v1/goals" && method === "GET")
        return json((yield* home.list("goal")).map((row) => JSON.parse(row.body)));
      const goalRoute = path.match(/^\/v1\/goals\/([a-zA-Z0-9_-]{1,64})(?:\/(run))?$/);
      if (goalRoute) {
        const id = goalRoute[1]!;
        if (method === "PUT" && !goalRoute[2]) {
          const body = yield* readBody(request, GoalInput);
          if (!(yield* home.read("kitty", body.kittyId)))
            return json({ code: "KITTY_NOT_FOUND", params: {} }, 400);
          const next = yield* Effect.try({
            try: () => nextSlot(body.schedule, body.timezone, Date.now()),
            catch: () => "INVALID_SCHEDULE",
          });
          const goal = yield* home.saveGoal(id, JSON.stringify({ ...body, nextSlot: next }));
          yield* home.insert(
            "chat",
            goal.chatId,
            JSON.stringify({
              id: goal.chatId,
              title: goal.title,
              members: [goal.kittyId],
              createdAt: Date.now(),
            }),
          );
          if (goal.enabled)
            yield* slots.start({ goalId: id, revision: goal.revision, slotTime: goal.nextSlot });
          return json(goal);
        }
        if (method === "DELETE" && !goalRoute[2]) {
          yield* home.remove("goal", id);
          return HttpServerResponse.empty({ status: 204 });
        }
        if (method === "POST" && goalRoute[2] === "run") {
          const saved = yield* home.read("goal", id);
          if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
          const body = yield* readBody(
            request,
            Schema.Struct({
              operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
            }),
          );
          const goal = JSON.parse(saved) as Goal;
          yield* chats.getByName(goal.chatId, { locationHint: "weur" }).enqueue({
            chatId: goal.chatId,
            messageId: `run-${body.operationId}`,
            kittyId: goal.kittyId,
            text: goal.instruction,
          });
          return json({ chatId: goal.chatId }, 202);
        }
      }
      if (path === "/v1/hooks" && method === "GET")
        return json(
          (yield* home.list("hook")).map((row) => {
            const value = JSON.parse(row.body);
            return {
              id: row.id,
              goalId: value.goalId,
              kind: value.kind,
              hasSecret: !!value.secret,
            };
          }),
        );
      const hookRoute = path.match(/^\/v1\/hooks\/([a-zA-Z0-9_-]{1,64})$/);
      if (hookRoute) {
        const id = hookRoute[1]!;
        if (method === "DELETE") {
          yield* home.remove("hook", id);
          return HttpServerResponse.empty({ status: 204 });
        }
        if (method === "PUT") {
          const body = yield* readBody(request, HookInput);
          if (!(yield* home.read("goal", body.goalId)))
            return json({ code: "GOAL_NOT_FOUND", params: {} }, 400);
          const old = yield* home.read("hook", id);
          const secret = body.secret
            ? yield* Effect.tryPromise({
                try: () => seal(env.KITTIES_KEK, `hooks:${id}:secret`, body.secret!),
                catch: () => "KEY_UNAVAILABLE",
              })
            : old
              ? JSON.parse(old).secret
              : undefined;
          if (!secret) return json({ code: "SECRET_REQUIRED", params: {} }, 400);
          yield* home.write(
            "hook",
            id,
            JSON.stringify({ goalId: body.goalId, kind: body.kind, secret }),
          );
          return json({ id, goalId: body.goalId, kind: body.kind, hasSecret: true });
        }
      }
      return undefined;
    });
  return { route, tick };
});
