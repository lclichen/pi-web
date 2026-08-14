//go:build windows

package pty

import "errors"

// Create is a stub on Windows so the agent still builds/runs (PTY is Linux/macOS
// only). Runtime PTY testing happens on the CentOS 7 target.
func (m *Manager) Create(shell, cwd string, cols, rows int, onOutput func(sessionID, data string)) (*Session, error) {
	return nil, errors.New("pty not supported on this build (Linux/macOS only)")
}
