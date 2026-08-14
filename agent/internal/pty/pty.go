// Package pty manages interactive pseudo-terminal sessions for the web terminal.
// Creation is platform-specific (creack/pty on Linux/macOS); on Windows it is a
// stub so the rest of the agent still builds and runs there.
package pty

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Session is one live PTY. Its methods are safe to call from any goroutine.
type Session struct {
	ID     string
	write  func([]byte) error
	resize func(cols, rows int) error
	close  func() error
}

// Write sends bytes to the PTY's input (keystrokes).
func (s *Session) Write(b []byte) error { return s.write(b) }

// Resize updates the terminal window size.
func (s *Session) Resize(cols, rows int) error { return s.resize(cols, rows) }

// Close releases the PTY and its child process.
func (s *Session) Close() error { return s.close() }

// Manager owns the set of live sessions.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

func (m *Manager) register(s *Session) {
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
}

// Close removes and closes one session.
func (m *Manager) Close(id string) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if ok {
		_ = s.Close()
	}
}

// CloseAll closes every session (used on relay disconnect/reconnect).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	for _, s := range m.sessions {
		_ = s.Close()
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
