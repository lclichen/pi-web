package agent

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"piagent/internal/config"
)

// menuUI is the interactive run screen. Two implementations: a plain
// line-oriented one for pipes/dumb terminals, and a three-zone dashboard
// (log / status / interaction) for a real terminal.
type menuUI interface {
	start()
	stop()
	refresh(entries []*config.ServerConfig, active *connector)
	ask(prompt string) (string, error)
	message(format string, args ...any)
	invalidate()
}

func newMenuUI(reader *bufio.Reader) menuUI {
	if dashboardEnabled() {
		return newDashboard(reader)
	}
	return &plainUI{reader: reader}
}

// ---------------------------------------------------------------------------
// Plain UI (fallback)
// ---------------------------------------------------------------------------

type plainUI struct {
	reader *bufio.Reader
}

func (p *plainUI) start() {}
func (p *plainUI) stop()  {}

func (p *plainUI) refresh(entries []*config.ServerConfig, active *connector) {
	fmt.Println()
	fmt.Println("Agent Client — 已保存的连接")
	if len(entries) == 0 {
		fmt.Println("  (尚未配对；按 n 新建连接)")
	}
	for i, entry := range entries {
		status := "未连接"
		if active != nil && active.entry.Server == entry.Server {
			status = active.getStatus()
			if status == "" {
				status = "连接中…"
			}
		}
		label := entry.Label
		if label == "" {
			label = "未命名"
		}
		fmt.Printf("  [%d] %-34s %-14s %s\n", i+1, entry.Server, label, status)
	}
	fmt.Println("编号=连接/切换  n=新建连接  d=断开  r=重新配对  l=刷新  q=退出")
}

func (p *plainUI) ask(prompt string) (string, error) {
	fmt.Println(prompt)
	line, err := p.reader.ReadString('\n')
	return strings.TrimSpace(line), err
}

func (p *plainUI) message(format string, args ...any) {
	fmt.Printf(format+"\n", args...)
}

func (p *plainUI) invalidate() {}

// ---------------------------------------------------------------------------
// Dashboard UI
// ---------------------------------------------------------------------------

const (
	ansiSaveCursor    = "\x1b7"
	ansiRestoreCursor = "\x1b8"
	ansiClearLine     = "\x1b[2K"
	// Bottom row is deliberately left blank: pressing Enter then moves the
	// cursor there instead of scrolling the whole dashboard up.
	promptRowOffset = 2
)

type dashboard struct {
	mu      sync.Mutex
	out     *os.File
	reader  *bufio.Reader
	width   int
	height  int
	logs    []string
	entries []*config.ServerConfig
	active  *connector
	prompt  string
	started bool
	closed  bool
}

func dashboardEnabled() bool {
	if !isTerminal(os.Stdin) || !isTerminal(os.Stdout) {
		return false
	}
	if !ansiSupported() {
		return false
	}
	return true
}

func newDashboard(reader *bufio.Reader) *dashboard {
	width, height, ok := terminalSize(os.Stdout)
	if !ok || width <= 0 {
		width = 80
	}
	if !ok || height <= 0 {
		height = 24
	}
	if width < 40 {
		width = 40
	}
	// Below this the three zones cannot all fit; the plain UI is more useful.
	if height < 10 {
		height = 10
	}
	return &dashboard{out: os.Stdout, reader: reader, width: width, height: height}
}

func (d *dashboard) start() {
	d.mu.Lock()
	if d.started {
		d.mu.Unlock()
		return
	}
	d.started = true
	d.mu.Unlock()
	// Alternate screen: the user's shell scrollback is restored on exit.
	fmt.Fprint(d.out, "\x1b[?1049h\x1b[2J\x1b[H")
	d.render()
}

func (d *dashboard) stop() {
	d.mu.Lock()
	if d.closed || !d.started {
		d.closed = true
		d.mu.Unlock()
		return
	}
	d.closed = true
	d.started = false
	d.mu.Unlock()
	fmt.Fprint(d.out, "\x1b[2J\x1b[H\x1b[?1049l")
}

// Write captures the standard logger's output into the log zone.
func (d *dashboard) Write(p []byte) (int, error) {
	text := strings.TrimRight(string(p), "\r\n")
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return len(p), nil
	}
	for _, line := range strings.Split(text, "\n") {
		d.logs = append(d.logs, line)
	}
	// Keep memory bounded; only the visible tail is ever rendered.
	if len(d.logs) > 2000 {
		d.logs = append([]string(nil), d.logs[len(d.logs)-1000:]...)
	}
	d.renderLocked()
	return len(p), nil
}

func (d *dashboard) message(format string, args ...any) {
	_, _ = d.Write([]byte(fmt.Sprintf(format, args...)))
}

func (d *dashboard) refresh(entries []*config.ServerConfig, active *connector) {
	d.mu.Lock()
	d.entries = entries
	d.active = active
	d.renderLocked()
	d.mu.Unlock()
}

func (d *dashboard) invalidate() {
	d.mu.Lock()
	d.renderLocked()
	d.mu.Unlock()
}

func (d *dashboard) ask(prompt string) (string, error) {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return "", io.EOF
	}
	d.prompt = prompt
	d.drawPromptLocked()
	d.mu.Unlock()

	line, err := d.reader.ReadString('\n')
	if err == nil {
		// The echoed input line is replaced by the next screen; clearing it
		// here avoids a stale "prompt + old input" row while a command runs.
		d.mu.Lock()
		d.clearPromptLocked()
		d.mu.Unlock()
	}
	return strings.TrimSpace(line), err
}

func (d *dashboard) drawPromptLocked() {
	row := d.height - promptRowOffset + 1
	fmt.Fprintf(d.out, "\x1b[%d;1H%s%s", row, ansiClearLine, truncateDisplay(d.prompt, d.width-1))
}

func (d *dashboard) clearPromptLocked() {
	row := d.height - promptRowOffset + 1
	fmt.Fprintf(d.out, "\x1b[%d;1H%s", row, ansiClearLine)
}

// statusLinesLocked builds the persistent status zone. Very long machine lists
// are truncated so the log and prompt zones always keep their space.
func (d *dashboard) statusLinesLocked() []string {
	maxEntries := d.height - 8
	if maxEntries < 1 {
		maxEntries = 1
	}
	entries := d.entries
	hidden := 0
	if len(entries) > maxEntries {
		hidden = len(entries) - maxEntries
		entries = entries[:maxEntries]
	}
	lines := []string{"Agent Client — 已保存的连接"}
	if len(entries) == 0 {
		lines = append(lines, "  (尚未配对；按 n 新建连接)")
	}
	for i, entry := range entries {
		status := "未连接"
		if d.active != nil && d.active.entry.Server == entry.Server {
			status = d.active.getStatus()
			if status == "" {
				status = "连接中…"
			}
		}
		label := entry.Label
		if label == "" {
			label = "未命名"
		}
		lines = append(lines, fmt.Sprintf("  [%d] %s  %s  %s", i+1, entry.Server, label, status))
	}
	if hidden > 0 {
		lines = append(lines, fmt.Sprintf("  … 另有 %d 个连接（./agent-client run --list 查看）", hidden))
	}
	lines = append(lines, "编号=连接/切换  n=新建连接  d=断开  r=重新配对  l=刷新  q=退出")
	return lines
}

func (d *dashboard) render() {
	d.mu.Lock()
	d.renderLocked()
	d.mu.Unlock()
}

// renderLocked repaints the log and status zones only. The prompt/input row is
// never touched, so text the user is typing survives refreshes.
func (d *dashboard) renderLocked() {
	if !d.started || d.closed {
		return
	}
	status := d.statusLinesLocked()
	promptRow := d.height - promptRowOffset + 1
	statusTop := promptRow - len(status)
	if statusTop < 2 {
		statusTop = 2
	}
	logHeight := statusTop - 2
	if logHeight < 0 {
		logHeight = 0
	}

	var b strings.Builder
	b.WriteString(ansiSaveCursor)
	start := len(d.logs) - logHeight
	if start < 0 {
		start = 0
	}
	for i := 0; i < logHeight; i++ {
		b.WriteString(fmt.Sprintf("\x1b[%d;1H%s", i+1, ansiClearLine))
		if idx := start + i; idx < len(d.logs) {
			b.WriteString(truncateDisplay(d.logs[idx], d.width))
		}
	}
	// Blank gap between the log and status zones (also clears rows that used
	// to hold logs before the status block grew).
	for row := logHeight + 1; row < statusTop; row++ {
		b.WriteString(fmt.Sprintf("\x1b[%d;1H%s", row, ansiClearLine))
	}
	for i, line := range status {
		b.WriteString(fmt.Sprintf("\x1b[%d;1H%s%s", statusTop+i, ansiClearLine, truncateDisplay(line, d.width)))
	}
	b.WriteString(ansiRestoreCursor)
	fmt.Fprint(d.out, b.String())
}

// ---------------------------------------------------------------------------
// Display-width helpers (CJK labels/statuses are two columns wide)
// ---------------------------------------------------------------------------

func runeWidth(r rune) int {
	switch {
	case r < 32 || (r >= 0x0300 && r <= 0x036F):
		return 0
	case r >= 0x1100 && r <= 0x115F,
		r >= 0x2E80 && r <= 0xA4CF,
		r >= 0xAC00 && r <= 0xD7A3,
		r >= 0xF900 && r <= 0xFAFF,
		r >= 0xFE30 && r <= 0xFE4F,
		r >= 0xFF00 && r <= 0xFF60,
		r >= 0xFFE0 && r <= 0xFFE6,
		r >= 0x1F300 && r <= 0x1F64F,
		r >= 0x1F900 && r <= 0x1F9FF,
		r >= 0x20000 && r <= 0x3FFFD:
		return 2
	}
	return 1
}

func displayWidth(s string) int {
	width := 0
	for _, r := range s {
		width += runeWidth(r)
	}
	return width
}

// truncateDisplay cuts s to max terminal columns, appending an ellipsis. It
// never lets a line wrap, which would break the dashboard's row math.
func truncateDisplay(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if displayWidth(s) <= max {
		return s
	}
	var b strings.Builder
	width := 0
	for _, r := range s {
		rw := runeWidth(r)
		if width+rw > max-1 {
			break
		}
		b.WriteRune(r)
		width += rw
	}
	b.WriteString("…")
	return b.String()
}
