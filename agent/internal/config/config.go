// Package config stores the client's pairing credentials in ONE file
// (~/.agent-client/config.json, mode 0600) as a map keyed by relay URL:
//
//	{
//	  "version": 2,
//	  "current": "http://10.99.9.7:30142",
//	  "servers": {
//	    "http://10.99.9.7:30142": { "server": "...", "token": "...", "machineId": "...", "label": "..." }
//	  }
//	}
//
// Older layouts are migrated on load: the single v1 config
// (~/.agent-client/config.json with server/token at the top level), the
// per-server profiles in ~/.agent-client/profiles/*.json, and the pre-0.3
// ~/.pi-agent/config.json. Migration writes the v2 file and leaves the old
// files in place as a backup.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const CurrentVersion = 2

// ServerConfig is one saved relay connection. The map key in Store.Servers is
// its Server (trimmed, no trailing slash).
type ServerConfig struct {
	Server        string `json:"server"`
	Token         string `json:"token"`
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	// MachineID is the stable per-server machine identity (generated on first
	// pairing) so the relay can distinguish this machine from the user's others.
	MachineID string `json:"machineId,omitempty"`
	// Label is the user-chosen display name sent at pairing/hello time.
	Label string `json:"label,omitempty"`
}

// Store is the v2 config file.
type Store struct {
	Version int                      `json:"version"`
	Current string                   `json:"current,omitempty"`
	Servers map[string]*ServerConfig `json:"servers"`

	file string
}

// DefaultDir returns ~/.agent-client.
func DefaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".agent-client"), nil
}

// LegacyDir returns ~/.pi-agent (pre-0.3 client name).
func LegacyDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pi-agent"), nil
}

// DefaultPath returns ~/.agent-client/config.json.
func DefaultPath() (string, error) {
	d, err := DefaultDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

// LegacyPath returns ~/.pi-agent/config.json (pre-0.3 client name).
func LegacyPath() (string, error) {
	d, err := LegacyDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

// ProfilesDir is the per-server layout written by 0.4.x and migrated here.
func ProfilesDir() (string, error) {
	d, err := DefaultDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "profiles"), nil
}

// normalizeServer trims the URL and trailing slashes so equivalent spellings
// map to one entry.
func normalizeServer(server string) string {
	return strings.TrimRight(strings.TrimSpace(server), "/")
}

// Path returns the on-disk path this store is bound to.
func (s *Store) Path() string { return s.file }

// SetPath overrides the on-disk path used by Save.
func (s *Store) SetPath(p string) {
	if p != "" {
		s.file = p
	}
}

// List returns the saved connections sorted by server URL.
func (s *Store) List() []*ServerConfig {
	out := make([]*ServerConfig, 0, len(s.Servers))
	for _, cfg := range s.Servers {
		out = append(out, cfg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Server < out[j].Server })
	return out
}

// Get returns the entry for a server URL, tolerating a trailing slash.
func (s *Store) Get(server string) *ServerConfig {
	return s.Servers[normalizeServer(server)]
}

// Set stores (or replaces) one connection and points Current at it.
func (s *Store) Set(cfg *ServerConfig) {
	cfg.Server = normalizeServer(cfg.Server)
	if s.Servers == nil {
		s.Servers = make(map[string]*ServerConfig)
	}
	// Drop an older spelling of the same server.
	for key := range s.Servers {
		if normalizeServer(key) == cfg.Server {
			delete(s.Servers, key)
		}
	}
	s.Servers[cfg.Server] = cfg
	s.Current = cfg.Server
}

// Delete removes a connection; Current clears when it pointed there.
func (s *Store) Delete(server string) {
	key := normalizeServer(server)
	delete(s.Servers, key)
	if s.Current == key {
		s.Current = ""
	}
}

// Resolve picks the connection to use: an explicit server wins, then Current,
// then the only saved entry. nil when the choice is ambiguous or empty.
func (s *Store) Resolve(server string) *ServerConfig {
	if server = normalizeServer(server); server != "" {
		return s.Get(server)
	}
	if s.Current != "" {
		if cfg := s.Get(s.Current); cfg != nil {
			return cfg
		}
	}
	if len(s.Servers) == 1 {
		for _, cfg := range s.Servers {
			return cfg
		}
	}
	return nil
}

// NewMachineID returns a fresh stable machine identity (32 hex chars).
func NewMachineID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate machine id: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

// EnsureMachineID returns the entry's machine id, generating + saving one when
// absent. Failure to persist is not fatal for the current run.
func (s *Store) EnsureMachineID(server string) (string, error) {
	cfg := s.Get(server)
	if cfg == nil {
		return "", fmt.Errorf("no saved connection for %s", normalizeServer(server))
	}
	if cfg.MachineID != "" {
		return cfg.MachineID, nil
	}
	id, err := NewMachineID()
	if err != nil {
		return "", err
	}
	cfg.MachineID = id
	if err := s.Save(); err != nil {
		return cfg.MachineID, nil
	}
	return cfg.MachineID, nil
}

// Save writes the store atomically with mode 0600.
func (s *Store) Save() error {
	if s.file == "" {
		p, err := DefaultPath()
		if err != nil {
			return err
		}
		s.file = p
	}
	if s.Version == 0 {
		s.Version = CurrentVersion
	}
	if s.Servers == nil {
		s.Servers = make(map[string]*ServerConfig)
	}
	if err := os.MkdirAll(filepath.Dir(s.file), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// v1File is the pre-0.5 single-connection file shape (also each profile file).
type v1File struct {
	Server        string `json:"server"`
	Token         string `json:"token"`
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	MachineID     string `json:"machineId,omitempty"`
	Label         string `json:"label,omitempty"`
}

// addFileEntries merges one legacy file into the store. It accepts the v1
// single-connection shape AND a v2 map (a profile that an explicit
// `run --config` already migrated in place). Existing servers win.
func (s *Store) addFileEntries(raw []byte, source string) bool {
	_ = source
	var probe struct {
		Servers map[string]*ServerConfig `json:"servers"`
	}
	if json.Unmarshal(raw, &probe) == nil && probe.Servers != nil {
		added := false
		for key, cfg := range probe.Servers {
			if cfg == nil || cfg.Token == "" {
				continue
			}
			server := normalizeServer(cfg.Server)
			if server == "" {
				server = normalizeServer(key)
			}
			if server == "" {
				continue
			}
			if _, exists := s.Servers[server]; exists {
				continue
			}
			cfg.Server = server
			s.Servers[server] = cfg
			added = true
		}
		return added
	}
	var old v1File
	if json.Unmarshal(raw, &old) != nil || normalizeServer(old.Server) == "" || old.Token == "" {
		return false
	}
	server := normalizeServer(old.Server)
	if _, exists := s.Servers[server]; exists {
		return false // the v2/default entry wins
	}
	s.Servers[server] = &ServerConfig{
		Server:        server,
		Token:         old.Token,
		WorkspaceRoot: old.WorkspaceRoot,
		MachineID:     old.MachineID,
		Label:         old.Label,
	}
	return true
}

// LoadStore reads the v2 store at path (or the default path), migrating the
// legacy single file, the per-server profiles and ~/.pi-agent/config.json on
// first use. It never fails when nothing exists yet: an empty store is
// returned for pairing to fill.
func LoadStore(path string) (*Store, error) {
	explicit := path != ""
	if !explicit {
		p, err := DefaultPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	s := &Store{Version: CurrentVersion, Servers: make(map[string]*ServerConfig), file: path}
	migrated := false

	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		var probe struct {
			Servers map[string]*ServerConfig `json:"servers"`
		}
		if json.Unmarshal(data, &probe) == nil && probe.Servers != nil {
			// v2
			var parsed Store
			if err := json.Unmarshal(data, &parsed); err != nil {
				return nil, fmt.Errorf("parse config %s: %w", path, err)
			}
			parsed.file = path
			parsed.normalize()
			return &parsed, nil
		}
		// v1 single file at the same path.
		if s.addFileEntries(data, path) {
			migrated = true
		}
	case !os.IsNotExist(err):
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}

	if !explicit {
		// 0.4.x per-server profiles.
		if dir, err := ProfilesDir(); err == nil {
			if matches, _ := filepath.Glob(filepath.Join(dir, "*.json")); len(matches) > 0 {
				sort.Strings(matches)
				for _, profile := range matches {
					if raw, err := os.ReadFile(profile); err == nil && s.addFileEntries(raw, profile) {
						migrated = true
					}
				}
			}
		}
		// Pre-0.3 legacy file.
		if legacy, err := LegacyPath(); err == nil && legacy != path {
			if raw, err := os.ReadFile(legacy); err == nil && s.addFileEntries(raw, legacy) {
				migrated = true
			}
		}
	}

	if migrated {
		if err := s.Save(); err != nil {
			return nil, fmt.Errorf("migrate config to %s: %w", path, err)
		}
	}
	return s, nil
}

func (s *Store) normalize() {
	if s.Servers == nil {
		s.Servers = make(map[string]*ServerConfig)
	}
	out := make(map[string]*ServerConfig, len(s.Servers))
	for key, cfg := range s.Servers {
		if cfg == nil || cfg.Token == "" {
			continue
		}
		server := normalizeServer(cfg.Server)
		if server == "" {
			server = normalizeServer(key)
		}
		if server == "" {
			continue
		}
		cfg.Server = server
		out[server] = cfg
	}
	s.Servers = out
	if s.Version < CurrentVersion {
		s.Version = CurrentVersion
	}
	s.Current = normalizeServer(s.Current)
	if _, ok := s.Servers[s.Current]; !ok {
		s.Current = ""
	}
}
