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

func TestWriteBase64KeepsBinaryBytes(t *testing.T) {
	root := t.TempDir()
	binary := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f}
	ws := &Workspace{Root: root}
	if _, err := ws.Write(map[string]interface{}{
		"path":          "docs/pic.png",
		"contentBase64": "iVBORw0KGgr/AH8=",
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(root, "docs", "pic.png"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(binary) {
		t.Fatalf("written length = %d, want %d", len(got), len(binary))
	}
	for i := range binary {
		if got[i] != binary[i] {
			t.Fatalf("byte %d = %#x, want %#x", i, got[i], binary[i])
		}
	}
}

func TestWriteRejectsInvalidBase64(t *testing.T) {
	ws := &Workspace{Root: t.TempDir()}
	if _, err := ws.Write(map[string]interface{}{"path": "x.bin", "contentBase64": "%%%"}); err == nil {
		t.Fatal("invalid base64 must fail instead of writing garbage")
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestManifestReturnsBaseRelativeFilesAndSkipsNoise(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "demo")
	writeTestFile(t, filepath.Join(base, ".pi/skills/demo/SKILL.md"), "# demo")
	writeTestFile(t, filepath.Join(base, ".pi/skills/demo/scripts/run.sh"), "echo hi")
	writeTestFile(t, filepath.Join(base, ".pi/skills/demo/.git/config"), "noise")
	writeTestFile(t, filepath.Join(base, ".pi/skills/demo/node_modules/lib/a.js"), "keep")
	writeTestFile(t, filepath.Join(base, ".pi/skills/demo/node_modules/.cache/a.js"), "noise")
	writeTestFile(t, filepath.Join(base, ".pi/attachments/pic.bin"), "binary")

	view, err := (&Workspace{Root: root}).For(map[string]interface{}{"base": base})
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	raw, err := view.Manifest(map[string]interface{}{
		"roots": []interface{}{".pi/skills", ".pi/attachments", ".pi/missing"},
	})
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	result := raw.(protocol.ManifestResult)
	if result.Truncated {
		t.Fatal("small tree must not be truncated")
	}
	got := map[string]protocol.ManifestEntry{}
	for _, entry := range result.Entries {
		got[entry.Path] = entry
	}
	want := []string{
		".pi/attachments/pic.bin",
		".pi/skills/demo/SKILL.md",
		".pi/skills/demo/node_modules/lib/a.js",
		".pi/skills/demo/scripts/run.sh",
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %v, want %d files", got, len(want))
	}
	for _, path := range want {
		entry, ok := got[path]
		if !ok {
			t.Fatalf("missing %s in %v", path, got)
		}
		if entry.Size <= 0 || entry.Mtime <= 0 {
			t.Fatalf("%s: size=%d mtime=%d", path, entry.Size, entry.Mtime)
		}
	}
	if _, ok := got[".pi/skills/demo/.git/config"]; ok {
		t.Fatal(".git must be skipped")
	}
	if _, ok := got[".pi/skills/demo/node_modules/.cache/a.js"]; ok {
		t.Fatal("node_modules/.cache must be skipped")
	}
}

func TestManifestRejectsEscapingRootsAndSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	if _, err := (&Workspace{Root: root}).Manifest(map[string]interface{}{
		"roots": []interface{}{"../outside"},
	}); err == nil || !strings.Contains(err.Error(), "outside workspace root") {
		t.Fatalf("escaping root error = %v", err)
	}

	outside := t.TempDir()
	writeTestFile(t, filepath.Join(outside, "secret.txt"), "secret")
	link := filepath.Join(root, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	raw, err := (&Workspace{Root: root}).Manifest(map[string]interface{}{
		"roots": []interface{}{"linked"},
	})
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	if entries := raw.(protocol.ManifestResult).Entries; len(entries) != 0 {
		t.Fatalf("symlinked root must be skipped, got %v", entries)
	}
}
