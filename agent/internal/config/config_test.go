package config

import (
	"encoding/json"
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

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadStoreEmpty(t *testing.T) {
	withHome(t)
	store, err := LoadStore("")
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	if len(store.Servers) != 0 {
		t.Fatalf("servers = %+v, want none", store.Servers)
	}
	if store.Resolve("") != nil {
		t.Fatal("empty store resolved a connection")
	}
}

func TestLoadStoreMigratesSingleV1File(t *testing.T) {
	home := withHome(t)
	path := filepath.Join(home, ".agent-client", "config.json")
	writeFile(t, path, `{"server":"http://a:30142","token":"token-a","label":"LapTop","machineId":"m1","workspaceRoot":"/home/me/proj"}`)

	store, err := LoadStore("")
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	entry := store.Get("http://a:30142")
	if entry == nil || entry.Token != "token-a" || entry.Label != "LapTop" || entry.MachineID != "m1" {
		t.Fatalf("migrated entry = %+v", entry)
	}
	if entry.WorkspaceRoot != "/home/me/proj" {
		t.Fatalf("workspaceRoot = %q", entry.WorkspaceRoot)
	}
	// The file is rewritten as v2 in place.
	raw, _ := os.ReadFile(path)
	var probe struct {
		Version int                      `json:"version"`
		Servers map[string]*ServerConfig `json:"servers"`
	}
	if json.Unmarshal(raw, &probe) != nil || probe.Version != CurrentVersion || probe.Servers["http://a:30142"] == nil {
		t.Fatalf("v2 file not written: %s", raw)
	}
}

func TestLoadStoreMigratesProfilesAndLegacy(t *testing.T) {
	home := withHome(t)
	dir := filepath.Join(home, ".agent-client")
	writeFile(t, filepath.Join(dir, "config.json"),
		`{"server":"http://a:30142","token":"ta","label":"A"}`)
	writeFile(t, filepath.Join(dir, "profiles", "http_b_30142.json"),
		`{"version":2,"current":"http://b:30142","servers":{
		  "http://b:30142":{"server":"http://b:30142","token":"tb","label":"B"},
		  "http://c:30142":{"server":"http://c:30142","token":"tc"}}}`)
	writeFile(t, filepath.Join(home, ".pi-agent", "config.json"),
		`{"server":"http://legacy:30142","token":"tl","label":"Old"}`)

	store, err := LoadStore("")
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	for _, server := range []string{"http://a:30142", "http://b:30142", "http://c:30142", "http://legacy:30142"} {
		if store.Get(server) == nil {
			t.Fatalf("missing migrated %s in %+v", server, store.Servers)
		}
	}
	// Idempotent: a second load reads the v2 file and adds nothing new.
	again, err := LoadStore("")
	if err != nil || len(again.Servers) != 4 {
		t.Fatalf("second load = %+v, %v", again, err)
	}
}

func TestStoreCRUDAndResolve(t *testing.T) {
	withHome(t)
	store, _ := LoadStore("")
	store.Set(&ServerConfig{Server: "http://a:30142/", Token: "ta", Label: "A"})
	store.Set(&ServerConfig{Server: "http://b:30142", Token: "tb", Label: "B"})

	if got := store.Get("http://a:30142"); got == nil || got.Token != "ta" {
		t.Fatalf("Get with trailing slash = %+v", got)
	}
	if store.Current != "http://b:30142" {
		t.Fatalf("Current = %q, want the last Set", store.Current)
	}
	if got := store.Resolve(""); got == nil || got.Server != "http://b:30142" {
		t.Fatalf("Resolve current = %+v", got)
	}
	if got := store.Resolve("http://a:30142"); got == nil || got.Token != "ta" {
		t.Fatalf("Resolve explicit = %+v", got)
	}
	if len(store.List()) != 2 || store.List()[0].Server != "http://a:30142" {
		t.Fatalf("List = %+v", store.List())
	}

	store.Delete("http://b:30142")
	if store.Current != "" || store.Get("http://b:30142") != nil {
		t.Fatalf("delete left current=%q servers=%+v", store.Current, store.Servers)
	}
	if got := store.Resolve(""); got == nil || got.Server != "http://a:30142" {
		t.Fatalf("Resolve after delete = %+v", got)
	}
}

func TestStorePersistsAcrossLoads(t *testing.T) {
	home := withHome(t)
	path := filepath.Join(home, ".agent-client", "config.json")
	store, _ := LoadStore("")
	store.Set(&ServerConfig{Server: "http://a:30142", Token: "ta", MachineID: "m1"})
	store.Set(&ServerConfig{Server: "http://b:30142", Token: "tb"})
	store.Current = "http://a:30142"
	if err := store.Save(); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if loaded.Get("http://a:30142") == nil || loaded.Get("http://b:30142") == nil || loaded.Current != "http://a:30142" {
		t.Fatalf("reloaded = %+v", loaded)
	}
}

func TestEnsureMachineIDPersists(t *testing.T) {
	home := withHome(t)
	store, _ := LoadStore("")
	store.Set(&ServerConfig{Server: "http://a:30142", Token: "ta"})
	id, err := store.EnsureMachineID("http://a:30142")
	if err != nil || len(id) != 32 {
		t.Fatalf("EnsureMachineID = %q, %v", id, err)
	}
	again, _ := LoadStore(filepath.Join(home, ".agent-client", "config.json"))
	if got := again.Get("http://a:30142"); got == nil || got.MachineID != id {
		t.Fatalf("machine id not persisted: %+v", got)
	}
}
