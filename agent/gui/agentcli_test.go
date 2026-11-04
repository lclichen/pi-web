package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withTempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	return home
}

func TestScanServerConfigs(t *testing.T) {
	home := withTempHome(t)
	dir := filepath.Join(home, ".agent-client")
	if err := os.MkdirAll(filepath.Join(dir, "profiles"), 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(dir, "config.json"),
		`{"server":"http://a:30142","token":"ta","label":"LapTop","machineId":"m1","workspaceRoot":"/home/me/proj"}`)
	write(filepath.Join(dir, "profiles", "http_b_30142.json"),
		`{"server":"http://b:30142","token":"tb","machineId":"m2"}`)
	// Half-paired files are skipped.
	write(filepath.Join(dir, "profiles", "incomplete.json"), `{"server":"http://c:30142"}`)

	servers := scanServerConfigs()
	if len(servers) != 2 {
		t.Fatalf("got %d servers, want 2: %+v", len(servers), servers)
	}
	if servers[0].Server != "http://a:30142" || !servers[0].Default || servers[0].Label != "LapTop" {
		t.Fatalf("default server = %+v", servers[0])
	}
	if servers[0].WorkspaceRoot != "/home/me/proj" {
		t.Fatalf("workspace root = %q", servers[0].WorkspaceRoot)
	}
	if servers[1].Server != "http://b:30142" || servers[1].Default {
		t.Fatalf("profile server = %+v", servers[1])
	}
	if servers[1].Label == "" {
		t.Fatal("a profile without a label should get the host fallback")
	}
}

func TestScanServerConfigsMissingDir(t *testing.T) {
	withTempHome(t)
	if servers := scanServerConfigs(); len(servers) != 0 {
		t.Fatalf("got %+v, want none", servers)
	}
}

func TestSaveSettingsKeepsLabelWhenEmpty(t *testing.T) {
	home := withTempHome(t)
	_ = home
	a := newApp()
	a.saveSettings("http://a:30142", "LapTop")
	a.saveSettings("http://b:30142", "")

	path, err := guiSettingsPath()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "http://b:30142") || !strings.Contains(got, "LapTop") {
		t.Fatalf("settings = %s, want the new address and the kept label", got)
	}
}

func TestServerForPairMatchesSavedPathOrAddress(t *testing.T) {
	a := newApp()
	configPath := filepath.Join("home", ".agent-client", "config.json")
	a.servers = []serverEntry{
		{Path: configPath, Server: "http://a:30142", Label: "A"},
		{Path: filepath.Join("home", ".agent-client", "profiles", "b.json"), Server: "http://b:30142", Label: "B"},
	}
	if s, ok := a.serverForPair("http://unrelated:1", configPath); !ok || s.Label != "A" {
		t.Fatalf("path match = %+v, %v", s, ok)
	}
	if s, ok := a.serverForPair("http://b:30142/", ""); !ok || s.Label != "B" {
		t.Fatalf("address match = %+v, %v (trailing slash tolerated)", s, ok)
	}
	if _, ok := a.serverForPair("http://c:30142", ""); ok {
		t.Fatal("unknown server must not match")
	}
}

func TestScanServerConfigsReadsLegacyDir(t *testing.T) {
	home := withTempHome(t)
	legacy := filepath.Join(home, ".pi-agent")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "config.json"),
		[]byte(`{"server":"http://legacy:30142","token":"tl","label":"Old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	servers := scanServerConfigs()
	if len(servers) != 1 || servers[0].Server != "http://legacy:30142" {
		t.Fatalf("legacy config not listed: %+v", servers)
	}
}

func TestEnsureServerVisibleAddsCustomPath(t *testing.T) {
	withTempHome(t)
	path := filepath.Join(t.TempDir(), "custom-config.json")
	if err := os.WriteFile(path,
		[]byte(`{"server":"http://custom:30142","token":"tc","label":"Custom"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	a := newApp()
	a.ensureServerVisible(path)
	if len(a.servers) != 1 || a.servers[0].Server != "http://custom:30142" {
		t.Fatalf("custom config not added: %+v", a.servers)
	}
	// Idempotent.
	a.ensureServerVisible(path)
	if len(a.servers) != 1 {
		t.Fatalf("duplicate added: %+v", a.servers)
	}
}
