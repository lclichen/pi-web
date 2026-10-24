package config

import (
	"os"
	"path/filepath"
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
