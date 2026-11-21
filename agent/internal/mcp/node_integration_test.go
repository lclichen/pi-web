package mcp

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestNodeStdioServer is a real-process smoke test for the MCP wire format
// (newline-delimited JSON-RPC) using the same Node pattern the built-in skill
// recommends. It is skipped when node is not installed.
func TestNodeStdioServer(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not installed")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "server.cjs")
	const source = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "node-helper", version: "1.0.0" }
    }});
  } else if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{
      name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }
    }]}});
  } else if (req.method === "tools/call") {
    send({ jsonrpc: "2.0", id: req.id, result: {
      content: [{ type: "text", text: "echo:" + (req.params.arguments.text || "") }]
    }});
  }
});
`
	if err := os.WriteFile(script, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}

	m := NewManager()
	t.Cleanup(m.CloseAll)
	cfg := Config{
		ServerKey: "node-helper",
		Command:   "node",
		Args:      []string{script},
		Dir:       dir,
	}
	tools, err := m.ListTools(cfg, 20*time.Second)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools) != 1 || tools[0]["name"] != "echo" {
		t.Fatalf("tools = %#v", tools)
	}
	result, err := m.CallTool(cfg, "echo", map[string]interface{}{"text": "hi"}, nil, 20*time.Second)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	content, _ := result["content"].([]interface{})
	if len(content) != 1 {
		t.Fatalf("content = %#v", result["content"])
	}
	part, _ := content[0].(map[string]interface{})
	if part["text"] != "echo:hi" {
		t.Fatalf("text = %#v", part["text"])
	}
}
