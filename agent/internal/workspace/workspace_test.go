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

func TestReadBase64KeepsBinaryBytes(t *testing.T) {
	root := t.TempDir()
	// 0x89 P N G ... — invalid UTF-8, must survive the JSON hop.
	binary := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f}
	if err := os.WriteFile(filepath.Join(root, "pic.png"), binary, 0o644); err != nil {
		t.Fatal(err)
	}
	ws := &Workspace{Root: root}
	raw, err := ws.Read(map[string]interface{}{"path": "pic.png", "encoding": "base64"})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	out := raw.(map[string]interface{})
	if out["encoding"] != "base64" {
		t.Fatalf("encoding = %v, want base64", out["encoding"])
	}
	encoded, _ := out["contentBase64"].(string)
	if encoded != "iVBORw0KGgr/AH8=" {
		t.Fatalf("contentBase64 = %q, want iVBORw0KGgr/AH8=", encoded)
	}
	if _, ok := out["content"]; ok {
		t.Fatal("base64 mode must not emit a lossy utf8 content field")
	}
}
