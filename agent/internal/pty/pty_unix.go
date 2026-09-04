//go:build !windows

package pty

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

// Create starts a PTY running shell in cwd with the given size. onOutput is
// invoked from a reader goroutine for every chunk the PTY emits; onExit fires
// once when the child exits (with its exit code) or the PTY closes. The
// session is auto-removed after onExit.
func (m *Manager) Create(shell, cwd string, cols, rows int, onOutput func(sessionID, data string), onExit func(sessionID string, code int)) (*Session, error) {
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
	// Own process group: shells spawn children (builds, su, daemons) — killing
	// only the direct child leaves orphans holding the pty open.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

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
	killGroup := func() {
		if cmd.Process != nil {
			// Negative pid = the whole process group.
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			_ = cmd.Process.Kill()
		}
	}
	s.close = func() error {
		// Closing the master unblocks the reader goroutine, which owns cmd.Wait
		// (single waiter, no double-Wait race). The group kill covers children.
		_ = master.Close()
		killGroup()
		return nil
	}
	m.register(s)

	go func() {
		// The PTY is a byte stream: a multi-byte UTF-8 rune split across reads
		// used to be stringified per chunk, garbling CJK output at random
		// chunk boundaries. Hold back a trailing partial rune until complete.
		var pending []byte
		buf := make([]byte, 4096)
		for {
			n, rerr := master.Read(buf)
			if n > 0 {
				chunk := append(pending, buf[:n]...)
				pending = nil
				if k := utf8TailLen(chunk); k > 0 && k < len(chunk) {
					pending = append(pending[:0:0], chunk[len(chunk)-k:]...)
					chunk = chunk[:len(chunk)-k]
				}
				if len(chunk) > 0 {
					onOutput(id, string(chunk))
				}
			}
			if rerr != nil {
				if len(pending) > 0 {
					onOutput(id, string(pending)) // flush tail (invalid bytes → U+FFFD)
				}
				_ = master.Close()
				killGroup()
				waitErr := cmd.Wait()
				code := 0
				if waitErr != nil {
					code = -1
					if ee, ok := waitErr.(*exec.ExitError); ok {
						code = ee.ExitCode()
					}
				}
				if onExit != nil {
					onExit(id, code)
				}
				m.Close(id)
				return
			}
		}
	}()

	return s, nil
}

// utf8TailLen reports the byte length of a trailing PARTIAL UTF-8 sequence
// (0 when the slice ends on a rune boundary).
func utf8TailLen(b []byte) int {
	n := 0 // continuation bytes seen at the tail
	for i := len(b) - 1; i >= 0 && n < 3; i-- {
		c := b[i]
		if c < 0x80 {
			return 0 // ASCII: clean boundary
		}
		if c&0xC0 == 0x80 {
			n++ // continuation byte (10xxxxxx)
			continue
		}
		// Leading byte (11xxxxxx): expected total length from its prefix.
		expected := 2
		if c&0xF0 == 0xF0 {
			expected = 4
		} else if c&0xE0 == 0xE0 {
			expected = 3
		}
		have := 1 + n
		if have < expected {
			return have // incomplete rune at the tail
		}
		return 0
	}
	return 0
}
