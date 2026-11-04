package provider

import (
	"context"
	"testing"
)

func TestOpenAIChatCompletionsUsesCompletionLimitForGPT5(t *testing.T) {
	client, transport := client(t, "openai", func(int) (int, string) { return 200, `{"choices":[{"message":{"content":"ready"}}]}` })
	client.opts.Model = "gpt-5.4-mini"
	client.opts.MaxTokens = 128
	if _, err := client.Complete(context.Background(), []Message{{Role: "user", Content: "ready"}}); err != nil {
		t.Fatal(err)
	}
	request := transport.calls[0]
	if request["max_completion_tokens"] != float64(128) {
		t.Fatal("completion budget missing")
	}
	if _, deprecated := request["max_tokens"]; deprecated {
		t.Fatal("sent parameter rejected by GPT-5")
	}
}

func TestChatTemperaturePreservesModelDefaultsAndExplicitChoices(t *testing.T) {
	zero, custom := 0.0, 0.3
	for _, tc := range []struct {
		name       string
		kind       string
		configured *float64
		want       any
	}{
		{"openai default", "openai", nil, nil},
		{"openai explicit zero", "openai", &zero, 0.0},
		{"compatible default", "groq", nil, 0.7},
		{"compatible explicit", "groq", &custom, 0.3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, transport := client(t, tc.kind, func(int) (int, string) {
				return 200, `{"choices":[{"message":{"tool_calls":[{"id":"call_1","function":{"name":"click","arguments":"{\"x\":5}"}}]}}]}`
			})
			c.opts.Model = "gpt-5.5"
			c.opts.Temperature = tc.configured
			reply, err := c.CompleteTools(context.Background(), convo, tools)
			if err != nil || len(reply.Calls) != 1 || reply.Calls[0].Name != "click" || reply.Calls[0].Args["x"] != 5.0 {
				t.Fatalf("tool reply: %+v, %v", reply, err)
			}
			request := transport.calls[0]
			if value, exists := request["temperature"]; value != tc.want || exists != (tc.want != nil) {
				t.Fatalf("temperature = %v (present %t), want %v", value, exists, tc.want)
			}
			if request["model"] != "gpt-5.5" {
				t.Fatalf("changed the requested model: %v", request["model"])
			}
			if image := imagePart(t, request, "messages", "content"); image["image_url"].(map[string]any)["url"] != "data:image/png;base64,UE5H" {
				t.Fatalf("image input changed: %v", image)
			}
			defs := request["tools"].([]any)
			if len(defs) != 1 || defs[0].(map[string]any)["function"].(map[string]any)["name"] != "click" {
				t.Fatalf("tool definition changed: %v", defs)
			}
		})
	}
}
