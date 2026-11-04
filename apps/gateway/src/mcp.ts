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
