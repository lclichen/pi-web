package mcp

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// TestHelperMcpServer is not a real test: the test binary re-executes itself
// with GO_WANT_HELPER_MCP=1 and speaks newline-delimited MCP JSON-RPC.
func TestHelperMcpServer(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_MCP") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()
	write := func(payload map[string]interface{}) {
		raw, _ := json.Marshal(payload)
		_, _ = writer.Write(append(raw, '\n'))
		_ = writer.Flush()
	}
	for scanner.Scan() {
		var req struct {
			ID     int64                  `json:"id"`
			Method string                 `json:"method"`
			Params map[string]interface{} `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			continue
		}
		switch req.Method {
		case "initialize":
			write(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": "2025-06-18",
					"capabilities":    map[string]interface{}{},
					"serverInfo":      map[string]interface{}{"name": "helper", "version": "1.0.0"},
				},
			})
		case "tools/list":
			write(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"tools": []map[string]interface{}{
						{
							"name":        "echo",
							"description": "Echo text",
							"inputSchema": map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"text": map[string]interface{}{"type": "string"},
								},
							},
						},
						{"name": "fail", "description": "Always fails", "inputSchema": map[string]interface{}{"type": "object"}},
					},
				},
			})
		case "tools/call":
			name, _ := req.Params["name"].(string)
			args, _ := req.Params["arguments"].(map[string]interface{})
			if name == "fail" {
				write(map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"result": map[string]interface{}{
						"content": []map[string]interface{}{{"type": "text", "text": "boom"}},
						"isError": true,
					},
				})
				continue
			}
			text, _ := args["text"].(string)
			write(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"content": []map[string]interface{}{{"type": "text", "text": "echo:" + text}},
				},
			})
		default:
			if req.ID != 0 {
				write(map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"error":   map[string]interface{}{"code": -32601, "message": "not found"},
				})
			}
		}
	}
}

func helperConfig(key string) Config {
	return Config{
		ServerKey: key,
		Command:   os.Args[0],
		Args:      []string{"-test.run=TestHelperMcpServer"},
		Env:       map[string]string{"GO_WANT_HELPER_MCP": "1"},
		Dir:       os.TempDir(),
	}
}

func TestListToolsAndCallTool(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.CloseAll)
	cfg := helperConfig("test-echo")

	tools, err := m.ListTools(cfg, 10*time.Second)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("tools = %d, want 2", len(tools))
	}
	if tools[0]["name"] != "echo" {
		t.Fatalf("first tool = %v", tools[0]["name"])
	}

	result, err := m.CallTool(cfg, "echo", map[string]interface{}{"text": "hi"}, map[string]interface{}{"amedac/user_id": 7}, 10*time.Second)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	content, _ := result["content"].([]interface{})
	if len(content) != 1 {
		t.Fatalf("content = %v", result["content"])
	}
	part, _ := content[0].(map[string]interface{})
	if part["text"] != "echo:hi" {
		t.Fatalf("text = %v", part["text"])
	}

	failed, err := m.CallTool(cfg, "fail", nil, nil, 10*time.Second)
	if err != nil {
		t.Fatalf("CallTool(fail): %v", err)
	}
	if failed["isError"] != true {
		t.Fatalf("isError = %v", failed["isError"])
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	m := NewManager()
	cfg := helperConfig("test-close")
	if _, err := m.ListTools(cfg, 10*time.Second); err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if !m.Close(cfg.ServerKey) {
		t.Fatal("Close should report a running server")
	}
	if m.Close(cfg.ServerKey) {
		t.Fatal("second Close should be a no-op")
	}
}

func TestBuildEnvDropsRelaySecretsAndHonorsOverrides(t *testing.T) {
	t.Setenv("PI_WEB_SECRET_TOKEN", "must-not-leak")
	t.Setenv("PATH", "/usr/bin")
	env := buildEnv(map[string]string{"CUSTOM": "1", "PATH": "/custom/bin"})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "PI_WEB_SECRET_TOKEN") {
		t.Fatalf("agent env leaked into MCP server: %s", joined)
	}
	if !strings.Contains(joined, "PATH=/custom/bin") {
		t.Fatalf("override missing: %s", joined)
	}
	if strings.Contains(joined, "PATH=/usr/bin") {
		t.Fatalf("override should replace inherited PATH: %s", joined)
	}
	if !strings.Contains(joined, "CUSTOM=1") {
		t.Fatalf("extra env missing: %s", joined)
	}
}

func TestRequestTimeoutDoesNotKillSharedServer(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.CloseAll)
	cfg := helperConfig("test-timeout")
	if _, err := m.ListTools(cfg, 10*time.Second); err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	// A zero timeout would use the default, so call with a tiny one through a
	// method the helper does not answer: the manager stays usable afterwards.
	m.mu.Lock()
	s := m.servers[cfg.ServerKey]
	m.mu.Unlock()
	if s == nil {
		t.Fatal("session missing")
	}
	if _, err := s.request("never/answers", map[string]interface{}{}, 30*time.Millisecond); err == nil {
		t.Fatal("expected timeout")
	}
	if _, err := m.CallTool(cfg, "echo", map[string]interface{}{"text": "after"}, nil, 10*time.Second); err != nil {
		t.Fatalf("server should still work after a timed-out request: %v", err)
	}
}
