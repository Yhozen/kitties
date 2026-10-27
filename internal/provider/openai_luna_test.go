package provider

import (
	"context"
	"strings"
	"testing"
)

func TestOpenAILunaVisionToolRoundTripUsesResponses(t *testing.T) {
	for _, model := range []string{"gpt-6-luna", "gpt-6-luna-2026-10-27"} {
		t.Run(model, func(t *testing.T) {
			c, transport := client(t, "openai", func(n int) (int, string) {
				if n == 1 {
					return 200, `{"output":[{"type":"reasoning"},{"type":"function_call","call_id":"colors-1","name":"report_colors","arguments":"{\"left\":\"red\",\"right\":\"blue\"}"}]}`
				}
				return 200, `{"output":[{"type":"message","content":[{"type":"output_text","text":"Red, blue."}]}],"usage":{"input_tokens":12,"output_tokens":4}}`
			})
			c.opts.Model = model
			c.opts.MaxTokens = 1024
			messages := []Message{
				{Role: "system", Content: "Record the observed colors, then answer."},
				{Role: "user", Content: "What colors are the squares?", Images: []Image{{MIME: "image/png", Data: []byte("PNG")}}},
			}
			functions := []Tool{{Name: "report_colors", Description: "Record observed colors", Parameters: map[string]any{"type": "object", "properties": map[string]any{"left": map[string]any{"type": "string"}, "right": map[string]any{"type": "string"}}}}}
			first, err := c.CompleteTools(context.Background(), messages, functions)
			if err != nil || len(first.Calls) != 1 || first.Calls[0].ID != "colors-1" || first.Calls[0].Args["left"] != "red" || first.Calls[0].Args["right"] != "blue" {
				t.Fatalf("vision tool call: %+v, %v", first, err)
			}
			messages = append(messages,
				Message{Role: "assistant", ToolCalls: first.Calls},
				Message{Role: "tool", ToolCallID: first.Calls[0].ID, ToolName: first.Calls[0].Name, Content: "Recorded the colors."},
			)
			second, err := c.CompleteTools(context.Background(), messages, functions)
			if err != nil || second.Content != "Red, blue." || second.Usage != (Usage{Input: 12, Output: 4}) {
				t.Fatalf("tool continuation: %+v, %v", second, err)
			}
			for i, body := range transport.calls {
				if transport.paths[i] != "https://api.openai.com/v1/responses" || transport.heads[i].Get("Authorization") != "Bearer k" || c.Describe() != "openai/"+model {
					t.Fatalf("wrong endpoint, authentication or identity: %s %s", transport.paths[i], c.Describe())
				}
				if body["model"] != model || body["max_output_tokens"] != float64(1024) || body["instructions"] != messages[0].Content {
					t.Fatalf("request settings changed: %v", body)
				}
				if _, set := body["temperature"]; set {
					t.Fatal("default temperature must remain unspecified")
				}
				if _, set := body["reasoning"]; set {
					t.Fatal("routing must not disable model reasoning")
				}
				input := body["input"].([]any)
				parts := input[0].(map[string]any)["content"].([]any)
				if len(parts) != 2 || parts[1].(map[string]any)["image_url"] != "data:image/png;base64,UE5H" {
					t.Fatalf("vision input lost: %v", parts)
				}
				defs := body["tools"].([]any)
				if len(defs) != 1 || defs[0].(map[string]any)["name"] != "report_colors" || defs[0].(map[string]any)["strict"] != false {
					t.Fatalf("function definition lost: %v", defs)
				}
			}
			input := transport.calls[1]["input"].([]any)
			call, result := input[1].(map[string]any), input[2].(map[string]any)
			if len(input) != 3 || call["type"] != "function_call" || call["call_id"] != "colors-1" || result["type"] != "function_call_output" || result["call_id"] != "colors-1" || result["output"] != "Recorded the colors." {
				t.Fatalf("stateless tool history changed: %v", input)
			}
		})
	}
}

func TestLunaResponsesPreservesExplicitTemperature(t *testing.T) {
	c, transport := client(t, "openai", func(int) (int, string) {
		return 200, `{"output":[{"type":"message","content":[{"type":"output_text","text":"ready"}]}]}`
	})
	c.opts.Model = "gpt-6-luna"
	temperature := 0.0
	c.opts.Temperature = &temperature
	if _, err := c.Complete(context.Background(), []Message{{Role: "user", Content: "ready"}}); err != nil {
		t.Fatal(err)
	}
	if value, set := transport.calls[0]["temperature"]; !set || value != 0.0 {
		t.Fatalf("explicit temperature was lost: %v", transport.calls[0])
	}
}

func TestLunaRoutingLeavesOtherChatModelsAndProvidersUnchanged(t *testing.T) {
	for _, tc := range []struct{ kind, model string }{
		{"openai", "gpt-5.5"},
		{"openai", "gpt-6-lunatic"},
		{"openai", "gpt-6-luna-preview"},
		{"groq", "gpt-6-luna"},
	} {
		t.Run(tc.kind+"/"+tc.model, func(t *testing.T) {
			c, transport := client(t, tc.kind, func(int) (int, string) { return 200, `{"choices":[{"message":{"content":"ready"}}]}` })
			c.opts.Model = tc.model
			if _, err := c.Complete(context.Background(), []Message{{Role: "user", Content: "ready"}}); err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(transport.paths[0], "/chat/completions") {
				t.Fatalf("changed another model's endpoint: %s", transport.paths[0])
			}
		})
	}
}
