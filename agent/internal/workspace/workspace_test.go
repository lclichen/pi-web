package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"piagent/internal/protocol"
)

func TestForWithoutBaseKeepsWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	ws := &Workspace{Root: root}

	view, err := ws.For(map[string]interface{}{})
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	if view != ws {
		t.Fatalf("expected the agent-wide workspace, got a view rooted at %q", view.GetRoot())
	}
}

func TestForScopesRelativePathsToBase(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "projects", "demo")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := &Workspace{Root: root}

	view, err := ws.For(map[string]interface{}{"base": base})
	if err != nil {
		t.Fatalf("For: %v", err)
	}

	abs, err := view.resolve("src/main.go")
	if err != nil {
		t.Fatalf("resolve inside base: %v", err)
	}
	if want := filepath.Join(base, "src", "main.go"); abs != want {
		t.Fatalf("resolve = %q, want %q", abs, want)
	}
	if again, err := view.resolve(".."); err == nil {
		t.Fatalf("base must fence '..': resolved to %q", again)
	}
	if got := view.relToRoot(abs); got != "src/main.go" {
		t.Fatalf("relToRoot = %q, want src/main.go", got)
	}
}

func TestForRejectsInvalidBase(t *testing.T) {
	root := t.TempDir()
	ws := &Workspace{Root: root}
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		base string
		want string
	}{
		{"relative", "projects/demo", "absolute"},
		{"missing", filepath.Join(root, "nope"), "does not exist"},
		{"file", file, "not a directory"},
	}
	for _, tc := range cases {
		_, err := ws.For(map[string]interface{}{"base": tc.base})
		if err == nil {
			t.Fatalf("%s: expected an error", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error = %q, want mention of %q", tc.name, err, tc.want)
		}
	}
}

func TestListWithBaseReturnsBaseRelativePaths(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "demo")
	if err := os.MkdirAll(filepath.Join(base, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	ws := &Workspace{Root: root}

	view, err := ws.For(map[string]interface{}{"base": base})
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	raw, err := view.List(map[string]interface{}{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	entries := raw.([]protocol.FsEntry)
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	if got := entries[0].Path; got != "src" {
		t.Fatalf("entry path = %v, want src", got)
	}
}
