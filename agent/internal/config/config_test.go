package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

func TestLoadPrefersNewClientDir(t *testing.T) {
	home := withHome(t)
	dir := filepath.Join(home, ".agent-client")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "config.json")
	if err := os.WriteFile(target, []byte(`{"server":"http://new","token":"new-token"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server != "http://new" || cfg.Token != "new-token" {
		t.Fatalf("loaded %+v, want the new config", cfg)
	}
	if cfg.Path() != target {
		t.Fatalf("path = %q, want %q", cfg.Path(), target)
	}
}

func TestLoadFallsBackToLegacyPiAgentDir(t *testing.T) {
	home := withHome(t)
	dir := filepath.Join(home, ".pi-agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "config.json")
	if err := os.WriteFile(target, []byte(`{"server":"http://legacy","token":"legacy-token"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server != "http://legacy" || cfg.Token != "legacy-token" {
		t.Fatalf("loaded %+v, want the legacy config", cfg)
	}
	// Saving keeps writing to the legacy file, so a downgrade to pi-agent still
	// finds its credentials.
	if cfg.Path() != target {
		t.Fatalf("path = %q, want legacy %q", cfg.Path(), target)
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("legacy config not rewritten: %v", err)
	}
}

// Multiple relays on one machine: each server gets its own profile file so a
// second pairing never overwrites the first token/workspace root.
func TestProfilePathIsPerServer(t *testing.T) {
	home := withHome(t)
	p1, err := ProfilePath("http://10.99.9.7:30141")
	if err != nil {
		t.Fatalf("ProfilePath: %v", err)
	}
	want := filepath.Join(home, ".agent-client", "profiles", "http_10.99.9.7_30141.json")
	if p1 != want {
		t.Fatalf("ProfilePath = %q, want %q", p1, want)
	}
	// Trailing slash is the same server.
	p2, _ := ProfilePath("http://10.99.9.7:30141/")
	if p1 != p2 {
		t.Fatalf("trailing slash changed the profile: %q vs %q", p1, p2)
	}
	// Different server (scheme/host/port) → different file, filesystem-safe.
	p3, _ := ProfilePath("https://[::1]:30141")
	if p1 == p3 {
		t.Fatal("different servers share a profile path")
	}
	base := filepath.Base(p3)
	if strings.ContainsAny(base, ":[]/\\") {
		t.Fatalf("profile file name is not safe: %q", base)
	}
}

func TestProfileConfigsDoNotOverwriteEachOther(t *testing.T) {
	withHome(t)
	// Default (first server).
	first := &Config{Server: "http://a:1", Token: "token-a"} // secret-scan:allow (test fixture)
	if err := first.Save(); err != nil {
		t.Fatalf("save default: %v", err)
	}
	// Second server → its own profile.
	profilePath, err := ProfilePath("http://b:1")
	if err != nil {
		t.Fatalf("ProfilePath: %v", err)
	}
	second := &Config{Server: "http://b:1", Token: "token-b"} // secret-scan:allow (test fixture)
	second.SetPath(profilePath)
	if err := second.Save(); err != nil {
		t.Fatalf("save profile: %v", err)
	}

	back, err := Load("")
	if err != nil || back.Server != "http://a:1" || back.Token != "token-a" {
		t.Fatalf("default config was overwritten: %+v (err %v)", back, err)
	}
	prof, err := Load(profilePath)
	if err != nil || prof.Server != "http://b:1" || prof.Token != "token-b" {
		t.Fatalf("profile config wrong: %+v (err %v)", prof, err)
	}
}

func TestExplicitPathWins(t *testing.T) {
	home := withHome(t)
	explicit := filepath.Join(home, "custom.json")
	if err := os.WriteFile(explicit, []byte(`{"server":"http://explicit","token":"t"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(explicit)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Server != "http://explicit" {
		t.Fatalf("loaded %+v, want explicit config", cfg)
	}
}
