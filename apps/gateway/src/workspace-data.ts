import { LibraryCatalogue } from "./library-snapshot.ts";
import { stored } from "./stored-records.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Workflows from "alchemy/Workflows";
import * as Schema from "effect/Schema";
import { Distill } from "./workflows/distill.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HomeDO, ChatDO } from "./actors.ts";
import { MemoryNoteInput, MemoryProfileInput, FeedbackInput } from "./entities.ts";
import { readBody } from "./request.ts";
import { validScope } from "./memory.ts";

const json = <Value>(value: Value, status = 200) =>
  HttpServerResponse.fromWeb(
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } }),
  );

const makeWorkspaceData = Effect.gen(function* () {
  const homes = yield* HomeDO,
    chats = yield* ChatDO;

  const catalogue = yield* LibraryCatalogue;

  const distill = yield* Workflows.RunWorkflow(Distill);

  return (request: Request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname,
        method = request.method,
        home = homes.getByName("owner", { locationHint: "weur" });

      const journalRoute = path.match(/^\/v1\/kitties\/([a-zA-Z0-9_-]{1,128})\/journal$/);

      if (journalRoute && method === "GET") {
        if (!(yield* home.read("kitty", journalRoute[1]!)))
          return json({ code: "KITTY_NOT_FOUND", params: {} }, 404);

        return json(
          (yield* home.list("kitty-journal"))
            .map((row) =>
              stored(Schema.Struct({ kittyId: Schema.String, at: Schema.Number }), row.body),
            )
            .filter((row) => row.kittyId === journalRoute[1])
            .sort((a, b) => a.at - b.at)
            .slice(-200),
        );
      }

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
        const payload = stored(Schema.Struct({ kittyId: Schema.String }), row.payload);

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

      const skillRoute = path.match(/^\/v1\/skills\/([a-zA-Z0-9_-]{1,128})(?:\/(accept))?$/);

      if (path === "/v1/skills" || skillRoute !== null) {
        if (method !== "GET")
          return json({ code: "LIBRARY_API_REQUIRED", params: { path: "/v1/library/rpc" } }, 409);
        const status = yield* home.libraryLegacyStatus();

        if (status.authority?.phase === "ready") {
          const current = yield* catalogue.read();

          if (skillRoute !== null) {
            const skill = current.skills.find((value) => value.id === skillRoute[1]);

            return skill === undefined ? json({ code: "NOT_FOUND", params: {} }, 404) : json(skill);
          }

          return json(current.skills);
        }

        if (status.authority !== null || status.frozen)
          return json({ code: "LIBRARY_UNAVAILABLE", params: {} }, 503);
      }

      if (path === "/v1/skills" && method === "GET")
        return json((yield* home.list("skill")).map((row) => JSON.parse(row.body)));

      if (skillRoute) {
        const id = skillRoute[1]!;

        const saved = yield* home.read("skill", id);

        if (!saved) return json({ code: "NOT_FOUND", params: {} }, 404);

        if (method === "GET") return json(JSON.parse(saved));
      }

      return undefined;
    });
});

export class WorkspaceData extends Context.Service<
  WorkspaceData,
  Effect.Success<typeof makeWorkspaceData>
>()("@kitties/gateway/WorkspaceData") {
  static readonly layer = Layer.effect(WorkspaceData, makeWorkspaceData);
}
