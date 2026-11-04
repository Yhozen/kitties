package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// --- chat completions (OpenAI-compatible) ---------------------------------------------------

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		Prompt     int `json:"prompt_tokens"`
		Completion int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *HTTPClient) callChat(ctx context.Context, t target, messages []Message, tools []Tool) (Reply, error) {
	body := map[string]any{
		"model":      c.opts.Model,
		"messages":   chatMessages(messages),
		"max_tokens": c.opts.MaxTokens,
	}
	if c.kind.Name != "openai" || c.opts.Temperature != nil {
		body["temperature"] = c.temperature(0.7)
	}
	if c.kind.Name == "openai" {
		delete(body, "max_tokens")
		body["max_completion_tokens"] = c.opts.MaxTokens
	}
	if len(tools) > 0 {
		defs := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			defs = append(defs, map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters}})
		}
		body["tools"] = defs
	}
	data, err := c.post(ctx, t, "/chat/completions", body)
	if err != nil {
		return Reply{}, err
	}
	var resp chatResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return Reply{}, fmt.Errorf("unreadable chat response: %w", err)
	}
	if resp.Error != nil && resp.Error.Message != "" {
		return Reply{}, &HTTPError{Code: 400, Body: resp.Error.Message}
	}
	if len(resp.Choices) == 0 {
		return Reply{}, errors.New("the provider returned no choices")
	}
	reply := Reply{Content: strings.TrimSpace(resp.Choices[0].Message.Content)}
	for i, tc := range resp.Choices[0].Message.ToolCalls {
		id := tc.ID
		if id == "" {
			id = fmt.Sprintf("call_%d", i)
		}
		reply.Calls = append(reply.Calls, ToolCall{ID: id, Name: tc.Function.Name, Args: argsOf(tc.Function.Arguments)})
	}
	if resp.Usage != nil {
		reply.Usage = Usage{Input: resp.Usage.Prompt, Output: resp.Usage.Completion}
	}
	if emptyReply(reply) {
		return Reply{}, fmt.Errorf("the provider returned an empty answer (finish_reason=%q)", resp.Choices[0].FinishReason)
	}
	return reply, nil
}

// chatMessages renders the conversation for /chat/completions: plain text, or text and image
// parts when a turn carries pictures.
func chatMessages(messages []Message) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	for _, m := range messages {
		if m.Role == "tool" {
			out = append(out, map[string]any{"role": "tool", "tool_call_id": m.ToolCallID, "content": m.Content})
			continue
		}
		if len(m.ToolCalls) > 0 {
			calls := make([]map[string]any, 0, len(m.ToolCalls))
			for _, tc := range m.ToolCalls {
				calls = append(calls, map[string]any{"id": tc.ID, "type": "function", "function": map[string]any{"name": tc.Name, "arguments": argsJSON(tc.Args)}})
			}
			out = append(out, map[string]any{"role": "assistant", "content": m.Content, "tool_calls": calls})
			continue
		}
		if len(m.Images) == 0 {
			out = append(out, map[string]any{"role": m.Role, "content": m.Content})
			continue
		}
		parts := []map[string]any{{"type": "text", "text": m.Content}}
		for _, img := range m.Images {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": img.dataURL()}})
		}
		out = append(out, map[string]any{"role": m.Role, "content": parts})
	}
	return out
}

// --- responses (codex) ---------------------------------------------------------------------

type responsesResponse struct {
	Output []struct {
		Type    string `json:"type"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"output"`
	Usage *struct {
		Input  int `json:"input_tokens"`
		Output int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *HTTPClient) callResponses(ctx context.Context, t target, messages []Message, tools []Tool) (Reply, error) {
	system, rest := splitSystem(messages)
	input := make([]map[string]any, 0, len(rest))
	for _, m := range rest {
		if m.Role == "tool" {
			input = append(input, map[string]any{"type": "function_call_output", "call_id": m.ToolCallID, "output": m.Content})
			continue
		}
		if len(m.ToolCalls) > 0 {
			if m.Content != "" {
				input = append(input, responsesText("assistant", m.Content))
			}
			for _, tc := range m.ToolCalls {
				input = append(input, map[string]any{"type": "function_call", "call_id": tc.ID, "name": tc.Name, "arguments": argsJSON(tc.Args)})
			}
			continue
		}
		item := responsesText(m.Role, m.Content)
		for _, img := range m.Images {
			item["content"] = append(item["content"].([]map[string]any), map[string]any{"type": "input_image", "image_url": img.dataURL()})
		}
		input = append(input, item)
	}
	body := map[string]any{
		"model": c.opts.Model,
		"input": input,
	}
	if c.kind.Name == "openai" && c.opts.Temperature != nil {
		body["temperature"] = *c.opts.Temperature
	}
	if system != "" {
		body["instructions"] = system
	}
	if t.chatgpt {
		// The ChatGPT backend wants the request streamed and not stored, with instructions
		// always present and no output cap.
		body["instructions"] = system
		body["stream"] = true
		body["store"] = false
	} else {
		body["max_output_tokens"] = c.opts.MaxTokens
	}
	if len(tools) > 0 {
		defs := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			definition := map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters}
			if c.kind.Name == "openai" {
				definition["strict"] = false
			}
			defs = append(defs, definition)
		}
		body["tools"] = defs
	}
	data, err := c.post(ctx, t, "/responses", body)
	if err != nil {
		return Reply{}, err
	}
	if t.chatgpt {
		return readResponsesStream(data)
	}
	var resp responsesResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return Reply{}, fmt.Errorf("unreadable responses answer: %w", err)
	}
	if resp.Error != nil && resp.Error.Message != "" {
		return Reply{}, &HTTPError{Code: 400, Body: resp.Error.Message}
	}
	var sb strings.Builder
	var calls []ToolCall
	for i, item := range resp.Output {
		switch item.Type {
		case "message":
			for _, part := range item.Content {
				if part.Type == "output_text" {
					sb.WriteString(part.Text)
				}
			}
		case "function_call":
			id := item.CallID
			if id == "" {
				id = fmt.Sprintf("call_%d", i)
			}
			calls = append(calls, ToolCall{ID: id, Name: item.Name, Args: argsOf(item.Arguments)})
		}
	}
	reply := Reply{Content: strings.TrimSpace(sb.String()), Calls: calls}
	if resp.Usage != nil {
		reply.Usage = Usage{Input: resp.Usage.Input, Output: resp.Usage.Output}
	}
	if emptyReply(reply) {
		return Reply{}, errors.New("the provider returned no text")
	}
	return reply, nil
}

// responsesText is one message item of a /responses input, in the typed form both the API and
// the ChatGPT backend take.
func responsesText(role, text string) map[string]any {
	kind := "input_text"
	if role == "assistant" {
		kind = "output_text"
	} else {
		role = "user"
	}
	return map[string]any{"type": "message", "role": role, "content": []map[string]any{{"type": kind, "text": text}}}
}

// responsesEvent is one server-sent event of a streamed /responses answer.
type responsesEvent struct {
	Type    string `json:"type"`
	Delta   string `json:"delta"`
	Message string `json:"message"`
	Item    struct {
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	Response struct {
		Usage *struct {
			Input  int `json:"input_tokens"`
			Output int `json:"output_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"response"`
}

// readResponsesStream reads a streamed /responses answer (the ChatGPT backend's) to its end: the
// text deltas, the finished function calls and the usage of the completed response.
func readResponsesStream(data []byte) (Reply, error) {
	var sb strings.Builder
	var reply Reply
	done := false
	for _, line := range strings.Split(string(data), "\n") {
		payload, ok := strings.CutPrefix(strings.TrimSpace(line), "data:")
		if !ok {
			continue
		}
		var ev responsesEvent
		if json.Unmarshal([]byte(strings.TrimSpace(payload)), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta":
			sb.WriteString(ev.Delta)
		case "response.output_item.done":
			if ev.Item.Type == "function_call" {
				id := ev.Item.CallID
				if id == "" {
					id = fmt.Sprintf("call_%d", len(reply.Calls))
				}
				reply.Calls = append(reply.Calls, ToolCall{ID: id, Name: ev.Item.Name, Args: argsOf(ev.Item.Arguments)})
			}
		case "response.completed", "response.done", "response.incomplete":
			done = true
			if u := ev.Response.Usage; u != nil {
				reply.Usage = Usage{Input: u.Input, Output: u.Output}
			}
		case "response.failed":
			msg := "the response failed"
			if ev.Response.Error != nil && ev.Response.Error.Message != "" {
				msg = ev.Response.Error.Message
			}
			return Reply{}, &HTTPError{Code: 500, Body: msg}
		case "error":
			return Reply{}, &HTTPError{Code: 400, Body: ev.Message}
		}
	}
	reply.Content = strings.TrimSpace(sb.String())
	if emptyReply(reply) {
		if !done {
			return Reply{}, errors.New("the response stream ended before the answer")
		}
		return Reply{}, errors.New("the provider returned no text")
	}
	return reply, nil
}

// --- anthropic -----------------------------------------------------------------------------

type anthropicResponse struct {
	Content []struct {
		Type  string         `json:"type"`
		Text  string         `json:"text"`
		ID    string         `json:"id"`
		Name  string         `json:"name"`
		Input map[string]any `json:"input"`
	} `json:"content"`
	Usage *struct {
		Input  int `json:"input_tokens"`
		Output int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *HTTPClient) callAnthropic(ctx context.Context, t target, messages []Message, tools []Tool) (Reply, error) {
	system, rest := splitSystem(messages)
	conversation := make([]map[string]any, 0, len(rest))
	for _, m := range rest {
		role := "user"
		if m.Role == "assistant" {
			role = "assistant"
		}
		var blocks []map[string]any
		switch {
		case m.Role == "tool":
			content := m.Content
			if content == "" {
				content = "done"
			}
			blocks = append(blocks, map[string]any{"type": "tool_result", "tool_use_id": m.ToolCallID, "content": content})
		default:
			if m.Content != "" || len(m.ToolCalls) == 0 {
				text := m.Content
				if text == "" {
					text = "(continue)"
				}
				blocks = append(blocks, map[string]any{"type": "text", "text": text})
			}
			for _, tc := range m.ToolCalls {
				args := tc.Args
				if args == nil {
					args = map[string]any{}
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": tc.ID, "name": tc.Name, "input": args})
			}
		}
		for _, img := range m.Images {
			blocks = append(blocks, map[string]any{"type": "image", "source": map[string]any{
				"type": "base64", "media_type": img.MIME, "data": base64.StdEncoding.EncodeToString(img.Data)}})
		}
		// Consecutive tool results share one user turn, which the API requires.
		if n := len(conversation); m.Role == "tool" && n > 0 && conversation[n-1]["role"] == "user" {
			if prev, ok := conversation[n-1]["content"].([]map[string]any); ok && len(prev) > 0 && prev[0]["type"] == "tool_result" {
				conversation[n-1]["content"] = append(prev, blocks...)
				continue
			}
		}
		conversation = append(conversation, map[string]any{"role": role, "content": blocks})
	}
	body := map[string]any{
		"model":      c.opts.Model,
		"messages":   conversation,
		"max_tokens": c.opts.MaxTokens,
	}
	if len(tools) > 0 {
		defs := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			defs = append(defs, map[string]any{"name": t.Name, "description": t.Description, "input_schema": t.Parameters})
		}
		body["tools"] = defs
	}
	if c.opts.Temperature != nil {
		body["temperature"] = *c.opts.Temperature
	}
	if system != "" {
		body["system"] = system
	}
	data, err := c.post(ctx, t, "/v1/messages", body)
	if err != nil {
		return Reply{}, err
	}
	var resp anthropicResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return Reply{}, fmt.Errorf("unreadable Anthropic response: %w", err)
	}
	if resp.Error != nil && resp.Error.Message != "" {
		return Reply{}, &HTTPError{Code: 400, Body: resp.Error.Message}
	}
	var sb strings.Builder
	var calls []ToolCall
	for i, block := range resp.Content {
		switch block.Type {
		case "text":
			sb.WriteString(block.Text)
		case "tool_use":
			id := block.ID
			if id == "" {
				id = fmt.Sprintf("toolu_%d", i)
			}
			args := block.Input
			if args == nil {
				args = map[string]any{}
			}
			calls = append(calls, ToolCall{ID: id, Name: block.Name, Args: args})
		}
	}
	reply := Reply{Content: strings.TrimSpace(sb.String()), Calls: calls}
	if resp.Usage != nil {
		reply.Usage = Usage{Input: resp.Usage.Input, Output: resp.Usage.Output}
	}
	if emptyReply(reply) {
		return Reply{}, errors.New("anthropic returned a response with no text")
	}
	return reply, nil
}

// --- gemini --------------------------------------------------------------------------------

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text         string `json:"text"`
				Thought      bool   `json:"thought"`
				FunctionCall *struct {
					Name string         `json:"name"`
					Args map[string]any `json:"args"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *struct {
		Prompt     int `json:"promptTokenCount"`
		Candidates int `json:"candidatesTokenCount"`
	} `json:"usageMetadata"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *HTTPClient) callGemini(ctx context.Context, t target, messages []Message, tools []Tool) (Reply, error) {
	system, rest := splitSystem(messages)
	contents := make([]map[string]any, 0, len(rest))
	for _, m := range rest {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		var parts []map[string]any
		switch {
		case m.Role == "tool":
			name := m.ToolName
			if name == "" {
				name = m.ToolCallID
			}
			parts = append(parts, map[string]any{"functionResponse": map[string]any{"name": name, "response": map[string]any{"result": m.Content}}})
		default:
			if m.Content != "" || len(m.ToolCalls) == 0 {
				parts = append(parts, map[string]any{"text": m.Content})
			}
			for _, tc := range m.ToolCalls {
				args := tc.Args
				if args == nil {
					args = map[string]any{}
				}
				parts = append(parts, map[string]any{"functionCall": map[string]any{"name": tc.Name, "args": args}})
			}
		}
		for _, img := range m.Images {
			parts = append(parts, map[string]any{"inlineData": map[string]any{
				"mimeType": img.MIME, "data": base64.StdEncoding.EncodeToString(img.Data)}})
		}
		contents = append(contents, map[string]any{"role": role, "parts": parts})
	}
	body := map[string]any{
		"contents": contents,
		"generationConfig": map[string]any{
			"maxOutputTokens": c.opts.MaxTokens,
			"temperature":     c.temperature(0.7),
		},
	}
	if system != "" {
		body["systemInstruction"] = map[string]any{"parts": []map[string]any{{"text": system}}}
	}
	if len(tools) > 0 {
		defs := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			defs = append(defs, map[string]any{"name": t.Name, "description": t.Description, "parameters": t.Parameters})
		}
		body["tools"] = []map[string]any{{"functionDeclarations": defs}}
	}
	data, err := c.post(ctx, t, "/v1beta/models/"+c.opts.Model+":generateContent", body)
	if err != nil {
		return Reply{}, err
	}
	var resp geminiResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return Reply{}, fmt.Errorf("unreadable Gemini response: %w", err)
	}
	if resp.Error != nil && resp.Error.Message != "" {
		return Reply{}, &HTTPError{Code: 400, Body: resp.Error.Message}
	}
	if len(resp.Candidates) == 0 {
		return Reply{}, errors.New("gemini returned no candidates (safety block?)")
	}
	var sb strings.Builder
	var calls []ToolCall
	for i, part := range resp.Candidates[0].Content.Parts {
		if part.FunctionCall != nil {
			args := part.FunctionCall.Args
			if args == nil {
				args = map[string]any{}
			}
			// Gemini has no call ids: the name is the id, which its response format matches by.
			calls = append(calls, ToolCall{ID: fmt.Sprintf("%s#%d", part.FunctionCall.Name, i), Name: part.FunctionCall.Name, Args: args})
			continue
		}
		if !part.Thought {
			sb.WriteString(part.Text)
		}
	}
	reply := Reply{Content: strings.TrimSpace(sb.String()), Calls: calls}
	if resp.UsageMetadata != nil {
		reply.Usage = Usage{Input: resp.UsageMetadata.Prompt, Output: resp.UsageMetadata.Candidates}
	}
	if emptyReply(reply) {
		return Reply{}, fmt.Errorf("gemini returned an empty answer (finishReason=%q)", resp.Candidates[0].FinishReason)
	}
	return reply, nil
}
