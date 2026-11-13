package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"piagent/internal/config"
	"piagent/internal/protocol"
	"piagent/internal/workspace"
)

func testEntry(root string) *config.ServerConfig {
	return &config.ServerConfig{Server: "http://relay:30142", Token: "t", WorkspaceRoot: root}
}

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

// --- workspace root resolution (0.4.1) ---------------------------------------

func setTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

func TestResolveWorkspaceRootPrefersCwd(t *testing.T) {
	setTestHome(t)
	project := t.TempDir()
	oldRoot := t.TempDir()
	t.Chdir(project)

	root, note, err := resolveWorkspaceRoot("", testEntry(oldRoot))
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !sameCleanPath(root, project) {
		t.Fatalf("root = %q, want the directory the client was started in (%q)", root, project)
	}
	if !strings.Contains(note, "ignoring saved root") {
		t.Fatalf("note = %q, want a warning about the ignored saved root", note)
	}
}

func TestResolveWorkspaceRootFlagWinsAndMustExist(t *testing.T) {
	setTestHome(t)
	t.Chdir(t.TempDir())
	flagRoot := t.TempDir()

	root, _, err := resolveWorkspaceRoot(flagRoot, testEntry(t.TempDir()))
	if err != nil || !sameCleanPath(root, flagRoot) {
		t.Fatalf("root = %q (err %v), want --root %q", root, err, flagRoot)
	}
	if _, _, err := resolveWorkspaceRoot(filepath.Join(flagRoot, "missing"), testEntry("")); err == nil {
		t.Fatal("a missing --root must be rejected")
	}
}

func TestResolveWorkspaceRootServiceModeUsesSavedRoot(t *testing.T) {
	home := setTestHome(t)
	t.Chdir(home) // service cwd: home is not a workspace choice
	saved := t.TempDir()

	root, note, err := resolveWorkspaceRoot("", testEntry(saved))
	if err != nil || !sameCleanPath(root, saved) || note != "" {
		t.Fatalf("root = %q note = %q err = %v, want saved %q", root, note, err, saved)
	}
}

func TestResolveWorkspaceRootDeletedSavedRootFallsBack(t *testing.T) {
	home := setTestHome(t)
	t.Chdir(home)
	gone := filepath.Join(t.TempDir(), "gone")

	root, note, err := resolveWorkspaceRoot("", testEntry(gone))
	if err != nil || !sameCleanPath(root, home) {
		t.Fatalf("root = %q (err %v), want home %q", root, err, home)
	}
	if !strings.Contains(note, "no longer exists") {
		t.Fatalf("note = %q, want the deleted-root warning", note)
	}
}

// A relay 409 must surface the live holder so the user knows what to stop.
func TestParseConflictReportsHolder(t *testing.T) {
	err := parseConflict([]byte(`{"code":"machine-connected","connection":{"hostname":"lab","agentVersion":"0.5.0"}}`))
	if !isDuplicateConnection(err) {
		t.Fatalf("err = %v, want errDuplicateConnection", err)
	}
	var dup *duplicateConnectionError
	if !errors.As(err, &dup) || !strings.Contains(dup.Error(), "lab") || !strings.Contains(dup.Error(), "0.5.0") {
		t.Fatalf("holder detail = %q", err.Error())
	}
	// A body without connection details still yields the sentinel.
	if !isDuplicateConnection(parseConflict(nil)) {
		t.Fatal("empty 409 body lost the duplicate sentinel")
	}
}

// A relay URL's trailing slash must not create a second config entry, and an
// explicit --server must win over the last-used one.
func TestStoreResolveKeepsOneEntryPerServer(t *testing.T) {
	setTestHome(t)
	dir := filepath.Join(t.TempDir(), "conf")
	store, err := config.LoadStore(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	store.Set(&config.ServerConfig{Server: "http://a:1/", Token: "ta"})
	store.Set(&config.ServerConfig{Server: "http://b:1", Token: "tb"})
	store.Set(&config.ServerConfig{Server: "http://a:1", Token: "ta2"})
	if len(store.Servers) != 2 {
		t.Fatalf("servers = %v, want 2 entries keyed by normalized URL", store.List())
	}
	if got := store.Get("http://a:1"); got == nil || got.Token != "ta2" {
		t.Fatalf("re-pair did not replace the entry: %+v", got)
	}
	if got := store.Resolve("http://a:1/"); got == nil || got.Server != "http://a:1" {
		t.Fatalf("Resolve(trailing slash) = %+v, want the a:1 entry", got)
	}
	if got := store.Resolve(""); got == nil || got.Server != "http://a:1" {
		t.Fatalf("Resolve(current) = %+v, want the last paired server", got)
	}
}
