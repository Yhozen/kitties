import type { Connection, ToolDefinition, ToolCall } from "./entities.ts";
import { allowedFetch } from "./outbound.ts";
import { jsonResponse } from "./oauth-core.ts";
export const nativeBase = {
  google: "https://www.googleapis.com",
  m365: "https://graph.microsoft.com/v1.0",
};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const text = { type: "string", maxLength: 1000 };
export function nativeTools(connection: Connection): ToolDefinition[] {
  const items = [
    {
      name: "files",
      description: "List files (up to 50)",
      parameters: object({ query: text }),
      readOnly: true,
    },
    {
      name: "events",
      description: "List upcoming calendar events (up to 50)",
      parameters: object({}),
      readOnly: true,
    },
    {
      name: "create_event",
      description: "Create a calendar event",
      parameters: object({ title: text, start: text, end: text, timezone: text }, [
        "title",
        "start",
        "end",
        "timezone",
      ]),
      readOnly: false,
    },
  ];
  return items.map((item) => ({
    name: `c_${connection.id.replace(/[^a-zA-Z0-9]/g, "")}_${item.name}`,
    description: `${connection.name}: ${item.description}`,
    parameters: item.parameters,
    connectionId: connection.id,
    remoteName: item.name,
    readOnly: item.readOnly,
    destructive: false,
  }));
}
export async function executeNative(
  connection: Connection,
  token: string | undefined,
  tool: ToolDefinition,
  call: ToolCall,
) {
  if (connection.kind !== "google" && connection.kind !== "m365") throw Error("TOOL_NOT_FOUND");
  const kind = connection.kind,
    base = nativeBase[kind];
  if (connection.url !== base || !token) throw Error("OAUTH_AUTHORIZATION_REQUIRED");
  if (!call.params || typeof call.params !== "object" || Array.isArray(call.params))
    throw Error("INVALID_ARGUMENTS");
  const params = call.params as Record<string, unknown>;
  let url: URL,
    method = "GET",
    body: string | undefined;
  switch (tool.remoteName) {
    case "files":
      if (kind === "google") {
        url = new URL(`${base}/drive/v3/files`);
        url.searchParams.set("pageSize", "50");
        url.searchParams.set("fields", "files(id,name,mimeType,webViewLink),nextPageToken");
        if (params.query !== undefined) {
          if (typeof params.query !== "string" || params.query.length > 1000)
            throw Error("INVALID_ARGUMENTS");
          url.searchParams.set(
            "q",
            `trashed=false and name contains '${params.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
          );
        }
      } else {
        url = new URL(`${base}/me/drive/root/children`);
        url.searchParams.set("$top", "50");
        url.searchParams.set("$select", "id,name,webUrl,file,folder");
        if (params.query !== undefined) {
          if (typeof params.query !== "string" || params.query.length > 1000)
            throw Error("INVALID_ARGUMENTS");
          url.searchParams.set("$filter", `startswith(name,'${params.query.replace(/'/g, "''")}')`);
        }
      }
      break;
    case "events":
      url = new URL(
        kind === "google" ? `${base}/calendar/v3/calendars/primary/events` : `${base}/me/events`,
      );
      if (kind === "google") {
        url.searchParams.set("maxResults", "50");
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("timeMin", new Date().toISOString());
        url.searchParams.set("orderBy", "startTime");
      } else {
        url.searchParams.set("$top", "50");
        url.searchParams.set("$filter", `start/dateTime ge '${new Date().toISOString()}'`);
        url.searchParams.set("$orderby", "start/dateTime");
      }
      break;
    case "create_event": {
      for (const key of ["title", "start", "end", "timezone"])
        if (typeof params[key] !== "string" || !params[key] || params[key].length > 1000)
          throw Error("INVALID_ARGUMENTS");
      const start = String(params.start),
        end = String(params.end),
        timezone = String(params.timezone);
      if (
        !Number.isFinite(Date.parse(start)) ||
        !Number.isFinite(Date.parse(end)) ||
        Date.parse(end) <= Date.parse(start)
      )
        throw Error("INVALID_ARGUMENTS");
      new Intl.DateTimeFormat("en", { timeZone: timezone });
      url = new URL(
        kind === "google" ? `${base}/calendar/v3/calendars/primary/events` : `${base}/me/events`,
      );
      method = "POST";
      body = JSON.stringify(
        kind === "google"
          ? {
              summary: params.title,
              start: { dateTime: start, timeZone: timezone },
              end: { dateTime: end, timeZone: timezone },
            }
          : {
              subject: params.title,
              start: { dateTime: start, timeZone: timezone },
              end: { dateTime: end, timeZone: timezone },
            },
      );
      break;
    }
    default:
      throw Error("TOOL_NOT_FOUND");
  }
  const result = await jsonResponse(
    await allowedFetch(url.href, [new URL(base).hostname], {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    }),
  );
  const serialized = JSON.stringify(result);
  if (serialized.length > 64000) throw Error("OUTPUT_LIMIT");
  return { untrusted: true, source: connection.name, result };
}
