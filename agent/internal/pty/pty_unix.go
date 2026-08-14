//go:build !windows

package pty

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// Create starts a PTY running shell in cwd with the given size. onOutput is
// invoked from a reader goroutine for every chunk the PTY emits, and stops when
// the PTY closes (the session is auto-removed on EOF/error). The session id is
// passed into onOutput (not captured) so there's no read-before-assign race.
func (m *Manager) Create(shell, cwd string, cols, rows int, onOutput func(sessionID, data string)) (*Session, error) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if shell == "" {
		shell = "/bin/sh"
	}

	cmd := exec.Command(shell)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}

	id := newID()
	s := &Session{ID: id}
	s.write = func(b []byte) error { _, e := master.Write(b); return e }
	s.resize = func(c, r int) error {
		return pty.Setsize(master, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
	}
	s.close = func() error {
		_ = master.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		return nil
	}
	m.register(s)

	go func() {
		buf := make([]byte, 4096)
		for {
			n, rerr := master.Read(buf)
			if n > 0 {
				onOutput(id, string(buf[:n]))
			}
			if rerr != nil {
				m.Close(id)
				return
			}
		}
	}()

	return s, nil
}
