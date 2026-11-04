package main

import (
	"encoding/json"
	"fmt"
	"github.com/madkoding/kitties/internal/config"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A smoke test of the whole stack but the model: the real gateway, the real provider client
// speaking the chat-completions protocol with native tool calls to a stand-in server, the real
// connectors, approvals, memory and notifications. Only the language model is a script.

// llm is an OpenAI-compatible server that answers a request to announce something with a tool
// call to the hook connector, and what the connector returned with a sentence.
type llm struct {
	mu       sync.Mutex
	requests int
	tools    []string
}

func (l *llm) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var req struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
		Tools []struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tools"`
	}
	_ = json.Unmarshal(raw, &req)
	l.mu.Lock()
	l.requests++
	if l.tools == nil {
		for _, t := range req.Tools {
			l.tools = append(l.tools, t.Function.Name)
		}
	}
	l.mu.Unlock()
	last := req.Messages[len(req.Messages)-1]
	w.Header().Set("Content-Type", "application/json")
	usage := `"usage":{"prompt_tokens":120,"completion_tokens":30}`
	switch {
	case last.Role == "tool" && strings.Contains(last.Content, "held:"):
		fmt.Fprintf(w, `{"choices":[{"message":{"content":"It is waiting for your yes."}}],%s}`, usage)
	case last.Role == "tool":
		fmt.Fprintf(w, `{"choices":[{"message":{"content":"Done: %s"}}],%s}`, "posted", usage)
	case strings.Contains(last.Content, "announce"):
		fmt.Fprintf(w, `{"choices":[{"message":{"content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"connector_hook","arguments":"{\"action\":\"send\",\"text\":\"We ship Friday\"}"}}]}}],%s}`, usage)
	default:
		fmt.Fprintf(w, `{"choices":[{"message":{"content":"Hello from the stand-in model."}}],%s}`, usage)
	}
}

// outside records what reaches the services the kitties write to.
type outside struct {
	mu   sync.Mutex
	hook []string
	push []string
}

func (o *outside) hookHandler(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	o.mu.Lock()
	o.hook = append(o.hook, string(b))
	o.mu.Unlock()
	_, _ = w.Write([]byte("ok"))
}

func (o *outside) pushHandler(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	o.mu.Lock()
	o.push = append(o.push, string(b))
	o.mu.Unlock()
	_, _ = w.Write([]byte(`{"id":"1"}`))
}

func (o *outside) sawHook() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.hook...)
}
func (o *outside) sawPush() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.push...)
}

// A kitty the person set to ask first holds a post, tells the person, and posts once on a yes.
func TestSmokeAKittyAsksBeforePostingAndTellsThePerson(t *testing.T) {
	withRuntime(t, false)
	model := &llm{}
	modelSrv := httptest.NewServer(model)
	defer modelSrv.Close()
	world := &outside{}
	mux := http.NewServeMux()
	mux.HandleFunc("/hook", world.hookHandler)
	mux.HandleFunc("/push", world.pushHandler)
	worldSrv := httptest.NewServer(mux)
	defer worldSrv.Close()

	cfg := writeConfig(t, modelSrv.URL)
	text, _ := os.ReadFile(cfg)
	text = []byte(strings.Replace(string(text), "gateway:\n", "connectors:\n  hook:\n    kind: slack\n    description: posts to the team channel\n    url: "+worldSrv.URL+"/hook\n  phone:\n    kind: ntfy\n    settings: {topic: kitties, url: "+worldSrv.URL+"/push}\nnotify:\n  connector: phone\n  on: [approval]\ngateway:\n", 1))
	text = []byte(strings.Replace(string(text), "  - name: mimi\n", "  - name: mimi\n    connectors: [hook]\n    desktop: false\n    approvals: ask\n", 1))
	if err := os.WriteFile(cfg, text, 0o600); err != nil {
		t.Fatal(err)
	}
	addr, _, errOut, stopGateway := serve(t, "-config", cfg, "gateway")
	var once sync.Once
	code := 0
	stop := func() int { once.Do(func() { code = stopGateway() }); return code }
	defer stop()
	tokenConfig, err := config.Load(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tok := strings.TrimSpace(mustRead(t, filepath.Join(tokenConfig.DataDirOr(), "gateway.token")))

	call := func(method, path string, body any) map[string]any {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = strings.NewReader(string(b))
		}
		req, _ := http.NewRequest(method, "http://"+addr+path, rd)
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		if resp.StatusCode >= 400 {
			t.Fatalf("%s %s = %d %s (gateway said: %s)", method, path, resp.StatusCode, data, errOut.String())
		}
		return m
	}
	eventually := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
			if ok() {
				return
			}
		}
		t.Fatalf("never happened: %s (gateway said: %s)", what, errOut.String())
	}

	// 1. The kitty is offered the connector as a native tool and answers a plain hello.
	chat := call("POST", "/v1/chats", map[string]any{"members": []string{"mimi"}})["chat"].(map[string]any)["id"].(string)
	call("POST", "/v1/chats/"+chat+"/messages", map[string]any{"text": "hello"})
	model.mu.Lock()
	offered := strings.Join(model.tools, ",")
	model.mu.Unlock()
	if !strings.Contains(offered, "connector_hook") || !strings.Contains(offered, "memory_remember") {
		t.Fatalf("the model was offered %q", offered)
	}

	// 2. Asked to announce, the model calls the connector: the action is held, nothing goes out,
	//    the person's phone is told, and the kitty says it waits.
	call("POST", "/v1/chats/"+chat+"/messages", map[string]any{"text": "please announce the launch"})
	pending := call("GET", "/v1/approvals?status=pending", nil)["approvals"].([]any)
	if len(pending) != 1 {
		t.Fatalf("pending = %v", pending)
	}
	ap := pending[0].(map[string]any)
	if !strings.Contains(ap["summary"].(string), "We ship Friday") || ap["risk"] != "ask" {
		t.Errorf("approval = %v", ap)
	}
	if got := world.sawHook(); len(got) != 0 {
		t.Fatalf("a held action went out: %v", got)
	}
	eventually("the phone is told", func() bool {
		p := world.sawPush()
		return len(p) == 1 && strings.Contains(p[0], "needs your approval") && strings.Contains(p[0], `"topic":"kitties"`)
	})
	got := call("GET", "/v1/chats/"+chat, nil)["chat"].(map[string]any)
	turns := got["turns"].([]any)
	if last := turns[len(turns)-1].(map[string]any)["text"].(string); !strings.Contains(last, "waiting for your yes") {
		t.Errorf("the kitty said %q", last)
	}

	// 3. A yes runs it, once, and the thread says so.
	call("POST", "/v1/approvals/"+ap["id"].(string)+"/approve", map[string]any{})
	if posts := world.sawHook(); len(posts) != 1 || !strings.Contains(posts[0], "We ship Friday") {
		t.Fatalf("after the yes the hook got %v", posts)
	}
	got = call("GET", "/v1/chats/"+chat, nil)["chat"].(map[string]any)
	turns = got["turns"].([]any)
	if last := turns[len(turns)-1].(map[string]any)["text"].(string); !strings.Contains(last, "Approved and done") {
		t.Errorf("the thread says %q", last)
	}

	// 4. A thumb down moves what the kitty knows about the person, and what the model spent today
	//    is counted against the kitty's budget.
	call("POST", fmt.Sprintf("/v1/chats/%s/turns/%d/feedback", chat, 1), map[string]any{"rating": "down", "note": "too long"})
	mem := call("GET", "/v1/kitties/mimi/memory", nil)
	if mem["profile"].(map[string]any)["down"].(float64) != 1 {
		t.Errorf("profile = %v", mem["profile"])
	}
	if spent := mem["spent"].(map[string]any); spent["tokens"].(float64) < 300 {
		t.Errorf("spent = %v", spent)
	}
	if stop() != 0 {
		t.Errorf("the gateway did not stop cleanly: %s", errOut.String())
	}
}
