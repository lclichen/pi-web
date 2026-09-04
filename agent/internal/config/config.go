// Package config loads/saves the agent's pairing credentials to
// ~/.pi-agent/config.json with mode 0600.
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

// DefaultDir returns ~/.pi-agent.
func DefaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pi-agent"), nil
}

// DefaultPath returns ~/.pi-agent/config.json.
func DefaultPath() (string, error) {
	d, err := DefaultDir()
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

// Load reads config from the given path (or the default if empty).
func Load(path string) (*Config, error) {
	if path == "" {
		p, err := DefaultPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	data, err := os.ReadFile(path)
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
