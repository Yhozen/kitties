import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { chatgptConfig } from "./chatgpt-config.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Prompt from "effect/ai/Prompt";
import type * as Chat from "effect/ai/Chat";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import * as CompatClient from "@effect/ai-openai-compat/OpenAiClient";
import * as CompatLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import type { Provider } from "./entities.ts";
import type { ToolCall, ToolDefinition } from "./entities.ts";
import * as Toolkit from "effect/ai/Toolkit";
import * as Tool from "effect/ai/Tool";
import { publicHttps } from "./outbound.ts";

export const providerBaseUrl = (provider: Pick<Provider, "kind" | "baseUrl">) =>
  publicHttps(
    (provider.kind === "chatgpt" ? chatgptConfig.protectedUrl : provider.baseUrl) ??
      {
        chatgpt: chatgptConfig.protectedUrl,
        openai: "https://api.openai.com/v1",
        anthropic: "https://api.anthropic.com",
        openrouter: "https://openrouter.ai/api/v1",
        gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
        compat: "https://api.groq.com/openai/v1",
      }[provider.kind],
  )
    .toString()
    .replace(/\/$/, "");

export const providerVerificationRequest = (
  provider: Pick<Provider, "kind" | "baseUrl">,
  secret: string,
) => {
  const base = providerBaseUrl(provider);
  const headers: Record<string, string> =
    provider.kind === "anthropic"
      ? { "x-api-key": secret, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${secret}` };
  return {
    base,
    endpoint: base + (provider.kind === "anthropic" ? "/v1/models" : "/models"),
    headers,
  };
};

export const modelLayer = (
  provider: Provider,
  secret: string,
): Layer.Layer<LanguageModel.LanguageModel> => {
  const options = { apiKey: Redacted.make(secret), apiUrl: providerBaseUrl(provider) };
  const config = provider.temperature === undefined ? {} : { temperature: provider.temperature };
  switch (provider.kind) {
    case "chatgpt":
      // The subscription adapter is admitted only after a real next Responses probe.
      return Layer.effect(LanguageModel.LanguageModel, Effect.die("CHATGPT_ADAPTER_NOT_ADMITTED"));
    case "openai":
      return OpenAiLanguageModel.layer({
        model: provider.model,
        config: { ...config, store: false, strictJsonSchema: false },
      }).pipe(Layer.provide(OpenAiClient.layer(options)), Layer.provide(FetchHttpClient.layer));
    case "anthropic":
      return AnthropicLanguageModel.layer({ model: provider.model, config }).pipe(
        Layer.provide(AnthropicClient.layer(options)),
        Layer.provide(FetchHttpClient.layer),
      );
    case "openrouter":
      return OpenRouterLanguageModel.layer({ model: provider.model, config }).pipe(
        Layer.provide(OpenRouterClient.layer(options)),
        Layer.provide(FetchHttpClient.layer),
      );
    default:
      return CompatLanguageModel.layer({ model: provider.model, config }).pipe(
        Layer.provide(CompatClient.layer(options)),
        Layer.provide(FetchHttpClient.layer),
      );
  }
};
// Never put a provider error (it may contain an HTTP body, URL or credentials)
// into a workflow journal. The owner gets a stable code and can test the key.
export const providerText = (
  provider: Provider,
  secret: string,
  session: Chat.Chat,
  prompt: Prompt.RawInput,
  onDelta: (text: string) => Effect.Effect<void, string>,
  definitions: ToolDefinition[] = [],
) =>
  Effect.gen(function* () {
    const calls: ToolCall[] = [];
    let tokens = 0;
    const toolkit = Toolkit.make(
      ...definitions.map((tool) =>
        Tool.dynamic(tool.name, { description: tool.description, parameters: tool.parameters }),
      ),
    );
    yield* session.streamText({ prompt, toolkit, disableToolCallResolution: true }).pipe(
      Stream.mapError(() => "PROVIDER_UNAVAILABLE"),
      Stream.runForEach((part) => {
        if (part.type === "text-delta") return onDelta(part.delta);
        if (part.type === "tool-call")
          calls.push({ id: part.id, name: part.name, params: part.params });
        if (part.type === "finish")
          tokens = (part.usage.inputTokens.total ?? 0) + (part.usage.outputTokens.total ?? 0);
        return Effect.void;
      }),
      Effect.provide(modelLayer(provider, secret)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    if (calls.length > 32) return yield* Effect.fail("TOOL_LIMIT");
    return { calls, tokens };
  });
