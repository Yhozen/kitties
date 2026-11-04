import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as McpClient from "effect/ai/McpClient";
import type { Connection, ToolDefinition, ToolCall } from "./entities.ts";
import { nativeTools, executeNative } from "./native-tools.ts";
import { withMcp } from "./mcp.ts";
import { allowedFetch, publicHttps } from "./outbound.ts";

const RequestMethod = Schema.Struct({ method: Schema.optional(Schema.String) });

const NotificationArguments = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(4000)),
});

const HttpArguments = Schema.Struct({
  path: Schema.String,
  method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(32000))),
});

export const discoverTools = (
  connection: Connection,
  token?: string,
): Effect.Effect<ToolDefinition[], string> => {
  if (connection.kind === "google" || connection.kind === "m365")
    return Effect.succeed(nativeTools(connection));
  const prefix = `c_${connection.id.replace(/[^a-zA-Z0-9]/g, "")}_`;

  if (connection.kind === "mcp")
    return withMcp(connection.url, token, (client) =>
      Effect.gen(function* () {
        const tools = yield* client.listTools({ limits: { maxItems: 64, maxPages: 4 } });
        // Validate remote schemas through the pinned MCP bridge. Execution is deliberately
        // resolved by the workflow, after the durable approval and effect ledger.
        yield* McpClient.toolkit(client, { prefix, trustAnnotations: false });

        const parameters = yield* Effect.forEach(tools, (tool) =>
          Schema.decodeUnknownEffect(Schema.JsonObject)(tool.inputSchema),
        );

        return tools.map((tool, index) => ({
          name: `${prefix}${index}`,
          description: `${connection.name}: ${tool.name}. ${tool.description ?? ""}`.slice(0, 2000),
          parameters: parameters[index]!,
          connectionId: connection.id,
          remoteName: tool.name,
          readOnly:
            connection.readTools?.includes(tool.name) === true &&
            tool.annotations?.readOnlyHint !== false,
          destructive: tool.annotations?.destructiveHint === true,
        }));
      }),
    );

  return Effect.succeed<ToolDefinition[]>([
    {
      name: prefix + "request",
      connectionId: connection.id,
      remoteName: "request",
      readOnly: false,
      destructive: false,
      description:
        connection.kind === "ntfy"
          ? `Send a notification to ${connection.name}`
          : `HTTPS request to the owner-configured host ${publicHttps(connection.url).hostname}`,
      parameters:
        connection.kind === "ntfy"
          ? {
              type: "object",
              properties: { message: { type: "string", maxLength: 4000 } },
              required: ["message"],
              additionalProperties: false,
            }
          : {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative path on the configured host" },
                method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
                body: { type: "string", maxLength: 32000 },
              },
              required: ["path", "method"],
              additionalProperties: false,
            },
    },
  ]);
};

export const needsApproval = (
  connection: Connection,
  tool: ToolDefinition,
  params: ToolCall["params"],
) => {
  if (!connection.allowReads) return true;

  if (connection.kind === "mcp")
    return !connection.readTools?.includes(tool.remoteName) || !tool.readOnly || tool.destructive;

  if (connection.kind === "google" || connection.kind === "m365")
    return !tool.readOnly || tool.destructive;

  if (connection.kind === "ntfy") return true;
  const decoded = Schema.decodeUnknownOption(RequestMethod)(params);

  if (Option.isNone(decoded)) return true;
  const method = decoded.value.method;

  return method !== "GET" && method !== "HEAD";
};

const boundedResponse = async (response: Response) => {
  const reader = response.body?.getReader();

  if (!reader) return "";
  let total = 0;
  const chunks: Uint8Array[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      total += value.length;

      if (total > 64000) throw Error("OUTPUT_LIMIT");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(bytes);
};

export const executeTool = (
  connection: Connection,
  token: string | undefined,
  tool: ToolDefinition,
  call: ToolCall,
): Effect.Effect<unknown, string> => {
  if (connection.kind === "google" || connection.kind === "m365")
    return Effect.tryPromise({
      try: () => executeNative(connection, token, tool, call),
      catch: () => "TOOL_UNAVAILABLE",
    });

  if (connection.kind === "mcp")
    return withMcp(connection.url, token, (client) =>
      Effect.gen(function* () {
        const descriptors = yield* client.listTools({ limits: { maxItems: 64, maxPages: 4 } });
        const descriptor = descriptors.find((item) => item.name === tool.remoteName);

        if (!descriptor) return yield* Effect.fail("TOOL_NOT_FOUND");

        // Re-discovery cannot lower the risk of the descriptor approved by the owner.
        if (
          (connection.readTools?.includes(descriptor.name) === true &&
            descriptor.annotations?.readOnlyHint !== false) !== tool.readOnly ||
          (descriptor.annotations?.destructiveHint === true && !tool.destructive)
        )
          return yield* Effect.fail("TOOL_CHANGED");

        const args = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(call.params);

        const result = yield* client.callTool({
          tool: descriptor,
          arguments: args,
        });

        const body = JSON.stringify(result);

        if (body.length > 64000) return yield* Effect.fail("OUTPUT_LIMIT");

        return { untrusted: true, source: connection.name, result };
      }),
    );

  return Effect.tryPromise({
    try: async () => {
      const base = publicHttps(connection.url);

      let url = base,
        method = "POST",
        body: string | undefined;

      if (connection.kind === "ntfy") {
        const params = Schema.decodeUnknownSync(NotificationArguments)(call.params);
        body = params.message;
      } else {
        const params = Schema.decodeUnknownSync(HttpArguments)(call.params);
        url = publicHttps(new URL(params.path, base).href);

        if (url.origin !== base.origin) throw Error();
        method = params.method;

        if (params.body !== undefined) {
          if (method === "GET" || method === "HEAD") throw Error();
          body = params.body;
        }
      }

      const response = await allowedFetch(url.href, [base.hostname], {
        method,
        body,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(30000),
      });

      return { untrusted: true, status: response.status, text: await boundedResponse(response) };
    },
    catch: () => "TOOL_UNAVAILABLE",
  });
};
