import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as McpClient from "effect/ai/McpClient";
import * as McpProtocol from "effect/ai/McpProtocol";
import { publicHttps } from "./outbound.ts";

export const withMcp = <A, E>(
  url: string,
  token: string | undefined,
  use: (client: McpClient.McpClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      publicHttps(url);
      const transport = yield* McpClient.http({
        url,
        protocol: McpProtocol.v2025_11_25,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      const client = yield* McpClient.make({
        name: "kitties",
        version: "1",
        timeout: "10 seconds",
      }).pipe(Effect.provideService(McpClient.Transport, transport));
      return yield* use(client);
    }),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.mapError(() => "MCP_UNAVAILABLE"),
  );

export const probeMcpEndpoints = Effect.gen(function* () {
  const servers = [
    ["GitHub", "https://api.githubcopilot.com/mcp/"],
    ["Stripe", "https://mcp.stripe.com"],
    ["Notion", "https://mcp.notion.com/mcp"],
    ["Linear", "https://mcp.linear.app/mcp"],
    ["Atlassian", "https://mcp.atlassian.com/v1/mcp"],
    ["Slack", "https://mcp.slack.com/mcp"],
    ["Fixture", "https://fixtures-next.kitties.rccpr.tech/mcp"],
  ] as const;
  const results = yield* Effect.forEach(
    servers,
    ([name, url]) =>
      withMcp(url, undefined, (client) =>
        Effect.gen(function* () {
          const tools = yield* client.listTools();
          const toolkit = yield* McpClient.toolkit(client, {
            prefix: "fixture_",
            trustAnnotations: false,
          });
          return {
            name,
            url,
            status: "passed",
            protocol: client.protocolVersion,
            tools: tools.map((tool) => tool.name),
            modelTools: Object.keys(toolkit.tools),
          };
        }),
      ).pipe(
        Effect.catch(() =>
          Effect.succeed({
            name,
            url,
            status: "requires-owner-authorization",
            disposition:
              "Configure the owner's OAuth or scoped static token; anonymous initialize/listTools did not succeed.",
          }),
        ),
      ),
    { concurrency: 1 },
  );
  return {
    date: new Date().toISOString(),
    runtime: "deployed Cloudflare Worker, Effect McpClient",
    results: [
      ...results,
      {
        name: "HomeAssistant",
        status: "requires-owner-instance",
        disposition: "No owner instance URL or token is configured.",
      },
    ],
  };
});
