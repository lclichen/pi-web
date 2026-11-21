package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"piagent/internal/workspace"
)

func TestMcpConfigFromParamsScopesCwdAndParsesEnv(t *testing.T) {
	root, err := os.MkdirTemp("", "agent-mcp-params-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	view, err := (&workspace.Workspace{Root: root}).For(map[string]interface{}{"base": root})
	if err != nil {
		t.Fatal(err)
	}
	cfg, timeout, err := mcpConfigFromParams(view, map[string]interface{}{
		"serverKey": "sess:relay",
		"command":   "node",
		"args":      []interface{}{".pi/mcp/cli.js", "--flag"},
		"env":       map[string]interface{}{"FOO": "bar", "BAD": 3.0},
		"cwd":       ".pi/mcp",
		"timeoutMs": float64(120000),
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerKey != "sess:relay" || cfg.Command != "node" {
		t.Fatalf("config = %+v", cfg)
	}
	if cfg.Dir != filepath.Join(root, ".pi", "mcp") {
		t.Fatalf("dir = %q", cfg.Dir)
	}
	if len(cfg.Args) != 2 || cfg.Args[0] != ".pi/mcp/cli.js" {
		t.Fatalf("args = %#v", cfg.Args)
	}
	if cfg.Env["FOO"] != "bar" || cfg.Env["BAD"] != "" {
		t.Fatalf("env = %#v", cfg.Env)
	}
	if timeout != 120*time.Second {
		t.Fatalf("timeout = %s", timeout)
	}
}

func TestMcpConfigFromParamsRejectsMissingKeyAndEscapes(t *testing.T) {
	root := t.TempDir()
	view, err := (&workspace.Workspace{Root: root}).For(map[string]interface{}{"base": root})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := mcpConfigFromParams(view, map[string]interface{}{"command": "node"}); err == nil {
		t.Fatal("missing serverKey must fail")
	}
	if _, _, err := mcpConfigFromParams(view, map[string]interface{}{
		"serverKey": "s",
		"command":   "node",
		"cwd":       "../outside",
	}); err == nil {
		t.Fatal("cwd escape must fail")
	}
}
