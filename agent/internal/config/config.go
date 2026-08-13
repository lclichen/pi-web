// Package config loads/saves the agent's pairing credentials to
// ~/.pi-agent/config.json with mode 0600.
package config

import (
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

	file string `json:"-"`
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
