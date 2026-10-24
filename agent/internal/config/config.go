// Package config loads/saves the client's pairing credentials to
// ~/.agent-client/config.json with mode 0600. Configs written by older
// pi-agent builds (~/.pi-agent/config.json) are read as a fallback and keep
// being written in place, so upgrading does not require re-pairing.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config holds the relay endpoint + token + optional workspace root.
type Config struct {
	Server        string `json:"server"`
	Token         string `json:"token"`
	WorkspaceRoot string `json:"workspaceRoot,omitempty"`
	// MachineID is a stable per-install identity (generated on first use) so
	// the relay can distinguish this machine from the user's OTHER machines.
	MachineID string `json:"machineId,omitempty"`
	// Label is the user-chosen display name sent at pairing time.
	Label string `json:"label,omitempty"`

	file string `json:"-"`
}

// EnsureMachineID returns the config's machine id, generating + persisting a
// fresh random one when absent. Called before pairing and before connecting so
// the identity is stable across restarts and re-pairings.
func (c *Config) EnsureMachineID() (string, error) {
	if c.MachineID != "" {
		return c.MachineID, nil
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate machine id: %w", err)
	}
	c.MachineID = hex.EncodeToString(raw)
	if err := c.Save(); err != nil {
		// Non-fatal for the current run: the id is still returned, it just may
		// not survive a restart.
		return c.MachineID, nil
	}
	return c.MachineID, nil
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

// Path returns the on-disk path this config is bound to.
func (c *Config) Path() string { return c.file }

// SetPath overrides the on-disk path used by Save.
func (c *Config) SetPath(p string) {
	if p != "" {
		c.file = p
	}
}

// Load reads config from the given path (or the default if empty). When the
// default path is missing, a legacy ~/.pi-agent/config.json is used instead
// (and remains the save target, so old installs keep working).
func Load(path string) (*Config, error) {
	explicit := path != ""
	if !explicit {
		p, err := DefaultPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	data, err := os.ReadFile(path)
	if err != nil && !explicit {
		if legacy, legacyErr := LegacyPath(); legacyErr == nil {
			if legacyData, readErr := os.ReadFile(legacy); readErr == nil {
				path = legacy
				data = legacyData
				err = nil
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	c.file = path
	return &c, nil
}

// Save writes the config atomically with mode 0600.
func (c *Config) Save() error {
	if c.file == "" {
		p, err := DefaultPath()
		if err != nil {
			return err
		}
		c.file = p
	}
	if err := os.MkdirAll(filepath.Dir(c.file), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.file)
}
