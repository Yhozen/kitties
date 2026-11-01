import * as Effect from "effect/Effect";
import * as Workflows from "alchemy/Workflows";
import * as Schema from "effect/Schema";
import { Distill } from "./workflows/distill.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO, ChatDO } from "./actors.ts";
import { MemoryNoteInput, MemoryProfileInput, SkillInput, FeedbackInput } from "./entities.ts";
import { readBody } from "./request.ts";
import { validScope } from "./memory.ts";
const json = (value: unknown, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } }),
  );
export const makeWorkspaceData = Effect.gen(function* () {
  const homes = yield* HomeDO,
    chats = yield* ChatDO;
  const distill = yield* Workflows.RunWorkflow(Distill);
  return (request: Request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname,
        method = request.method,
        home = homes.getByName("owner", { locationHint: "weur" });
      const distillRoute = path.match(/^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/distill$/);
      if (distillRoute && method === "POST") {
        if (!(yield* home.read("kitty", distillRoute[1]!)))
          return json({ code: "KITTY_NOT_FOUND", params: {} }, 404);
        const body = yield* readBody(
          request,
          Schema.Struct({
            operationId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)),
          }),
        );
        return json(
          {
            executionId: (yield* distill.start({
              kittyId: distillRoute[1]!,
              operationId: body.operationId,
            })).executionId,
          },
          202,
        );
      }
      const memoryRoute = path.match(
        /^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/memory(?:\/(profile|[a-zA-Z0-9_-]{1,128}))?$/,
      );
      if (memoryRoute) {
        const id = memoryRoute[1]!;
        if (!(yield* home.read("kitty", id)))
          return json({ code: "KITTY_NOT_FOUND", params: {} }, 404);
        if (method === "GET" && !memoryRoute[2]) return json(yield* home.memory(id));
        if (method === "POST" && !memoryRoute[2]) {
          const body = yield* readBody(request, MemoryNoteInput);
          if (!validScope(body.scope)) return json({ code: "INVALID_MEMORY", params: {} }, 400);
          return json(
            yield* home.mutateMemory(
              id,
              JSON.stringify({
                type: "remember",
                ...body,
                id: crypto.randomUUID(),
                source: "person",
                pinned: true,
                at: Date.now(),
              }),
            ),
            201,
          );
        }
        if (method === "PUT" && memoryRoute[2] === "profile") {
          const body = yield* readBody(request, MemoryProfileInput);
          return json(yield* home.mutateMemory(id, JSON.stringify({ type: "profile", ...body })));
        }
        if (method === "DELETE" && memoryRoute[2])
          return json(
            yield* home.mutateMemory(id, JSON.stringify({ type: "forget", id: memoryRoute[2] })),
          );
      }
      const feedbackRoute = path.match(
        /^\/v1\/chats\/([a-zA-Z0-9_-]{1,128})\/messages\/([a-zA-Z0-9_-]{1,128})\/feedback$/,
      );
      if (feedbackRoute && method === "POST") {
        const body = yield* readBody(request, FeedbackInput);
        const row = yield* chats
          .getByName(feedbackRoute[1]!, { locationHint: "weur" })
          .run(feedbackRoute[2]!);
        if (!row) return json({ code: "NOT_FOUND", params: {} }, 404);
        const payload = JSON.parse(row.payload) as { kittyId: string };
        return json(
          yield* home.mutateMemory(
            payload.kittyId,
            JSON.stringify({
              type: "feedback",
              id: `${feedbackRoute[1]}/${feedbackRoute[2]}`,
              ...body,
              at: Date.now(),
            }),
          ),
        );
      }
      if (path === "/v1/skills" && method === "GET")
        return json((yield* home.list("skill")).map((row) => JSON.parse(row.body)));
      const skillRoute = path.match(/^\/v1\/skills\/([a-zA-Z0-9_-]{1,128})(?:\/(accept))?$/);
      if (skillRoute) {
        const id = skillRoute[1]!;
        if (method === "PUT" && !skillRoute[2]) {
          const body = yield* readBody(request, SkillInput),
            skill = { ...body, id, updatedAt: Date.now() };
          yield* home.write("skill", id, JSON.stringify(skill));
          return json(skill);
        }
        if (method === "DELETE" && !skillRoute[2]) {
          yield* home.remove("skill", id);
          return HttpServerResponse.empty({ status: 204 });
        }
        const saved = yield* home.read("skill", id);
        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);
        if (method === "POST" && skillRoute[2] === "accept") {
          const skill = { ...JSON.parse(saved), status: "accepted", updatedAt: Date.now() };
          yield* home.write("skill", id, JSON.stringify(skill));
          return json(skill);
        }
        if (method === "GET") return json(JSON.parse(saved));
      }
      return undefined;
    });
});
