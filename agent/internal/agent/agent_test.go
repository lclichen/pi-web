package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"piagent/internal/config"
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

	root, note, err := resolveWorkspaceRoot("", &config.Config{WorkspaceRoot: oldRoot})
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

	root, _, err := resolveWorkspaceRoot(flagRoot, &config.Config{WorkspaceRoot: t.TempDir()})
	if err != nil || !sameCleanPath(root, flagRoot) {
		t.Fatalf("root = %q (err %v), want --root %q", root, err, flagRoot)
	}
	if _, _, err := resolveWorkspaceRoot(filepath.Join(flagRoot, "missing"), &config.Config{}); err == nil {
		t.Fatal("a missing --root must be rejected")
	}
}

func TestResolveWorkspaceRootServiceModeUsesSavedRoot(t *testing.T) {
	home := setTestHome(t)
	t.Chdir(home) // service cwd: home is not a workspace choice
	saved := t.TempDir()

	root, note, err := resolveWorkspaceRoot("", &config.Config{WorkspaceRoot: saved})
	if err != nil || !sameCleanPath(root, saved) || note != "" {
		t.Fatalf("root = %q note = %q err = %v, want saved %q", root, note, err, saved)
	}
}

func TestResolveWorkspaceRootDeletedSavedRootFallsBack(t *testing.T) {
	home := setTestHome(t)
	t.Chdir(home)
	gone := filepath.Join(t.TempDir(), "gone")

	root, note, err := resolveWorkspaceRoot("", &config.Config{WorkspaceRoot: gone})
	if err != nil || !sameCleanPath(root, home) {
		t.Fatalf("root = %q (err %v), want home %q", root, err, home)
	}
	if !strings.Contains(note, "no longer exists") {
		t.Fatalf("note = %q, want the deleted-root warning", note)
	}
}

func TestPairTargetConfigPath(t *testing.T) {
	setTestHome(t)

	// Fresh install → default config file (empty sentinel).
	if path, profile := pairTargetConfigPath("", "http://a:1"); path != "" || profile {
		t.Fatalf("fresh install: path=%q profile=%v, want the default file", path, profile)
	}
	first := &config.Config{Server: "http://a:1", Token: "t"}
	if err := first.Save(); err != nil {
		t.Fatal(err)
	}
	// Same server (trailing slash tolerated) → keep the default file.
	if path, profile := pairTargetConfigPath("", "http://a:1/"); path != "" || profile {
		t.Fatalf("re-pair: path=%q profile=%v, want the default file", path, profile)
	}
	// Different server → its own profile.
	path, profile := pairTargetConfigPath("", "http://b:1")
	if !profile || path == "" {
		t.Fatalf("second server: path=%q profile=%v, want a profile file", path, profile)
	}
	// Explicit --config always wins.
	if path, profile := pairTargetConfigPath("custom.json", "http://b:1"); path != "custom.json" || profile {
		t.Fatalf("explicit config: path=%q profile=%v, want custom.json", path, profile)
	}
}
