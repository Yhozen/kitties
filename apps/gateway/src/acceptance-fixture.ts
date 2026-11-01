import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
export class FixtureCounter extends Cloudflare.DurableObject<FixtureCounter>()(
  "FixtureCounter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() => {
      const sql = state.raw.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY,n INTEGER NOT NULL)");
      return {
        record: (id: string) =>
          Effect.sync(() => {
            sql.exec("INSERT INTO calls VALUES (?,1) ON CONFLICT(id) DO UPDATE SET n=n+1", id);
            return sql.exec<{ n: number }>("SELECT n FROM calls WHERE id=?", id).toArray()[0]!.n;
          }),
        count: (id: string) =>
          Effect.sync(
            () =>
              sql.exec<{ n: number }>("SELECT n FROM calls WHERE id=?", id).toArray()[0]?.n ?? 0,
          ),
      };
    });
  }),
) {}
// Fixed acceptance data only; no application or secret bindings.
export default class AcceptanceFixture extends Cloudflare.Worker<AcceptanceFixture>()(
  "AcceptanceFixture",
  {
    main: import.meta.url,
    domain: "fixtures-next.kitties.rccpr.tech",
    workersDev: false,
  },
  Effect.gen(function* () {
    const counters = yield* FixtureCounter;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request,
          url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/mcp") {
          const body = yield* Effect.tryPromise(() => request.json()) as Effect.Effect<
            { id?: string | number; method: string; params?: { arguments?: { probeId?: string } } },
            unknown
          >;
          if (body.id === undefined) return HttpServerResponse.empty({ status: 202 });
          const result =
            body.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "Kitties acceptance", version: "1" },
                }
              : body.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "sample",
                        description: "Return sample data and count this request",
                        inputSchema: {
                          type: "object",
                          properties: { probeId: { type: "string" } },
                          required: ["probeId"],
                          additionalProperties: false,
                        },
                        annotations: { readOnlyHint: false, destructiveHint: true },
                      },
                    ],
                  }
                : body.method === "tools/call"
                  ? {
                      content: [
                        {
                          type: "text",
                          text: `sample data, calls=${yield* counters.getByName("counts").record((body.params?.arguments?.probeId ?? "default").slice(0, 100))}`,
                        },
                      ],
                    }
                  : {};
          return HttpServerResponse.fromWeb(Response.json({ jsonrpc: "2.0", id: body.id, result }));
        }
        if (request.method === "GET" && url.pathname.startsWith("/count/"))
          return HttpServerResponse.fromWeb(
            Response.json({
              count: yield* counters.getByName("counts").count(url.pathname.slice(7)),
            }),
          );
        if (
          request.method === "POST" &&
          url.pathname === "/model/v1/chat/completions" &&
          request.headers.get("Authorization") === "Bearer kitties-acceptance-fixture"
        ) {
          const body = yield* Effect.tryPromise(() => request.json()) as Effect.Effect<
            {
              messages: { role: string; content?: string | { type: string; text?: string }[] }[];
              tools?: { function: { name: string } }[];
            },
            unknown
          >;
          const last = body.messages.at(-1);
          const rawUser = body.messages.findLast((message) => message.role === "user")?.content;
          const user =
            typeof rawUser === "string"
              ? rawUser
              : (rawUser
                  ?.filter((part) => part.type === "text")
                  .map((part) => part.text ?? "")
                  .join("") ?? "");
          const desktop = user.match(/^fixture:desktop:([a-z_]+):(.*)$/s);
          const name = desktop
            ? body.tools?.find((tool) => tool.function.name === `desktop_${desktop[1]}`)?.function
                .name
            : body.tools?.[0]?.function.name;
          const tool =
            last?.role === "user" && (user.startsWith("fixture:tool:") || !!desktop) && name;
          const encoder = new TextEncoder();
          const chunk = (delta: unknown, finish_reason: string | null = null) =>
            encoder.encode(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );
          let timer: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              if (user === "fixture:slow") {
                let i = 0;
                timer = setInterval(() => {
                  controller.enqueue(chunk({ content: "slow " }));
                  if (++i === 40) {
                    clearInterval(timer);
                    controller.enqueue(chunk({}, "stop"));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                  }
                }, 250);
                return;
              }
              if (tool) {
                controller.enqueue(
                  chunk({
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_fixture",
                        type: "function",
                        function: {
                          name,
                          arguments: desktop
                            ? desktop[2]!
                            : JSON.stringify({ probeId: user.slice(13) }),
                        },
                      },
                    ],
                  }),
                );
                controller.enqueue(chunk({}, "tool_calls"));
              } else {
                controller.enqueue(
                  chunk({
                    content:
                      last?.role === "tool"
                        ? `Tool completed: ${typeof last.content === "string" ? last.content : JSON.stringify(last.content)}`
                        : "Hola, prueba completada.",
                  }),
                );
                controller.enqueue(chunk({}, "stop"));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
            cancel() {
              clearInterval(timer);
            },
          });
          return HttpServerResponse.fromWeb(
            new Response(stream, {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
            }),
          );
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
    };
  }),
) {}
