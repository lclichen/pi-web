package agent

import (
	"os"
	"path/filepath"
	"testing"

	"piagent/internal/protocol"
	"piagent/internal/workspace"
)

// The relay's per-request `base` must reach the method implementations —
// regressing this silently puts project workspaces back on the agent root.
func TestCallMethodHonorsPerRequestBase(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "projects", "demo")
	if err := os.MkdirAll(filepath.Join(base, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws := &workspace.Workspace{Root: root}

	raw, err := callMethod("fs.list", map[string]interface{}{"base": base}, ws)
	if err != nil {
		t.Fatalf("fs.list: %v", err)
	}
	entries := raw.([]protocol.FsEntry)
	if len(entries) != 1 || entries[0].Name != "src" || entries[0].Path != "src" {
		t.Fatalf("fs.list entries = %+v, want one 'src' entry relative to base", entries)
	}

	raw, err = callMethod("fs.read", map[string]interface{}{"base": base, "path": "src/main.go"}, ws)
	if err != nil {
		t.Fatalf("fs.read: %v", err)
	}
	read := raw.(map[string]interface{})
	if got := read["path"]; got != "src/main.go" {
		t.Fatalf("fs.read path = %v, want src/main.go", got)
	}

	if _, err := callMethod("fs.read", map[string]interface{}{"base": base, "path": "../outside.txt"}, ws); err == nil {
		t.Fatal("fs.read escaped the request base")
	}
}

func TestCallMethodRejectsRelativeBase(t *testing.T) {
	ws := &workspace.Workspace{Root: t.TempDir()}
	if _, err := callMethod("fs.list", map[string]interface{}{"base": "relative/dir"}, ws); err == nil {
		t.Fatal("expected a relative base to be rejected")
	}
}
