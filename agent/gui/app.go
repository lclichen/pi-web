package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const guiVersion = "0.1.0"

type connStatus int

const (
	connConnecting connStatus = iota
	connConnected
	connReconnecting
	connFailed
)

type connection struct {
	cmd      *exec.Cmd
	status   connStatus
	detail   string
	stopping bool
}

type connView struct {
	status connStatus
	detail string
	active bool
}

type guiSettings struct {
	Address string `json:"address"`
	Label   string `json:"label"`
}

// app is the window state. The UI thread owns the form fields (paste,
// address, code, label); everything a background goroutine also touches is
// guarded by mu and read as a snapshot when a frame is built.
type app struct {
	win *mygo.Window

	mu            sync.Mutex
	agentBin      string
	agentVersion  string
	agentErr      string
	servers       []serverEntry
	conns         map[string]*connection
	busy          bool
	formMsg       string
	formErr       bool
	lastAddress   string
	lastLabel     string
	pendingToasts []ui.Toast

	// Pairing form (UI thread only).
	paste   string
	address string
	code    string
	label   string
}

func newApp() *app {
	return &app{conns: make(map[string]*connection)}
}

func (a *app) invalidate() {
	if win := a.win; win != nil {
		win.Invalidate()
	}
}

// loadSettings runs before the window exists, so the first frame already has
// the last-used address and client name. An empty saved name stays empty: the
// CLI keeps the machine's existing name when `pair` gets no --label.
func (a *app) loadSettings() {
	path, err := guiSettingsPath()
	if err != nil {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var s guiSettings
	if json.Unmarshal(data, &s) != nil {
		return
	}
	a.lastAddress = strings.TrimSpace(s.Address)
	a.lastLabel = strings.TrimSpace(s.Label)
	a.address = a.lastAddress
	a.label = a.lastLabel
}

func (a *app) saveSettings(address, label string) {
	a.mu.Lock()
	a.lastAddress = address
	if label != "" {
		a.lastLabel = label
	}
	saved := guiSettings{Address: a.lastAddress, Label: a.lastLabel}
	a.mu.Unlock()

	path, err := guiSettingsPath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func guiSettingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "agent-client-gui", "settings.json"), nil
}

func (a *app) discoverAgent() {
	path, version, err := resolveAgentClient()
	a.mu.Lock()
	a.agentBin = path
	a.agentVersion = version
	if err != nil {
		a.agentErr = err.Error()
	} else {
		a.agentErr = ""
	}
	a.mu.Unlock()
	a.invalidate()
}

func (a *app) refreshServers() {
	servers := scanServerConfigs()
	a.mu.Lock()
	a.servers = servers
	a.mu.Unlock()
	a.invalidate()
}

func (a *app) setForm(msg string, isErr bool) {
	a.mu.Lock()
	a.formMsg = msg
	a.formErr = isErr
	a.mu.Unlock()
	a.invalidate()
}

func (a *app) toast(t ui.Toast) {
	a.mu.Lock()
	if len(a.pendingToasts) < 4 {
		a.pendingToasts = append(a.pendingToasts, t)
	}
	a.mu.Unlock()
	a.invalidate()
}

// applyParsed fills the server address and/or pairing code from pasted text.
// Fields the text does not mention are left untouched.
func (a *app) applyParsed(text string) {
	server, code := ParsePairingText(text)
	if server == "" && code == "" {
		a.setForm("未能从粘贴内容识别服务器地址或配对码", true)
		return
	}
	if server != "" {
		a.address = server
	}
	if code != "" {
		a.code = code
	}
	switch {
	case server != "" && code != "":
		a.setForm("已识别服务器地址和配对码，确认后点「配对并保存」", false)
	case server != "":
		a.setForm("已识别服务器地址，请填写配对码", false)
	default:
		a.setForm("已识别配对码，请填写服务器地址", false)
	}
}

// startPair runs `agent-client pair` in the background. An empty label is not
// passed at all, so the CLI keeps the machine's saved client name.
func (a *app) startPair(address, code, label string) {
	address = strings.TrimSpace(address)
	code = strings.TrimSpace(code)
	label = strings.TrimSpace(label)
	if address == "" || code == "" {
		a.setForm("请填写服务器地址和配对码", true)
		return
	}
	a.mu.Lock()
	if a.busy {
		a.mu.Unlock()
		return
	}
	bin := a.agentBin
	a.busy = true
	a.mu.Unlock()
	a.setForm("正在配对…", false)

	go func() {
		if bin == "" {
			a.finishPair(false, "未找到 agent-client 可执行文件，无法配对")
			return
		}
		args := []string{"pair", "--code", code, "--server", address}
		if label != "" {
			args = append(args, "--label", label)
		}
		out, err := exec.Command(bin, args...).CombinedOutput()
		text := string(out)
		if err != nil {
			a.finishPair(false, "配对失败："+lastLine(text, err))
			return
		}
		a.saveSettings(address, label)
		a.refreshServers()
		msg := "配对成功"
		if saved := savedConfigPath(text); saved != "" {
			msg += "，凭据已保存"
		}
		a.finishPair(true, msg)
	}()
}

func (a *app) finishPair(ok bool, msg string) {
	a.mu.Lock()
	a.busy = false
	a.formMsg = msg
	a.formErr = !ok
	a.mu.Unlock()
	kind := "success"
	if !ok {
		kind = "error"
	}
	a.toast(ui.Toast{Title: msg, Type: kind})
}

func lastLine(output string, fallback error) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	if fallback != nil {
		return fallback.Error()
	}
	return "未知错误"
}

// savedConfigPath reads the CLI's "token saved to <path>" line.
func savedConfigPath(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "token saved to ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "token saved to "))
		}
	}
	return ""
}

// --- connections ------------------------------------------------------------

func (a *app) startConnection(server serverEntry) {
	a.mu.Lock()
	if existing, ok := a.conns[server.Path]; ok && existing.cmd != nil {
		a.mu.Unlock()
		return
	}
	conn := &connection{status: connConnecting, detail: "正在启动客户端…"}
	a.conns[server.Path] = conn
	bin := a.agentBin
	a.mu.Unlock()
	a.invalidate()

	if bin == "" {
		a.setConn(server.Path, connFailed, "未找到 agent-client 可执行文件")
		return
	}
	cmd := exec.Command(bin, "run", "--config", server.Path)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		a.setConn(server.Path, connFailed, err.Error())
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.setConn(server.Path, connFailed, err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		a.setConn(server.Path, connFailed, err.Error())
		return
	}
	a.mu.Lock()
	if current := a.conns[server.Path]; current == conn {
		conn.cmd = cmd
	}
	a.mu.Unlock()

	go a.pumpLog(server.Path, stderr)
	go a.pumpLog(server.Path, stdout)
	go func() {
		waitErr := cmd.Wait()
		a.mu.Lock()
		current := a.conns[server.Path]
		if current == nil || current.cmd != cmd {
			a.mu.Unlock()
			return
		}
		switch {
		case current.stopping:
			delete(a.conns, server.Path)
		case waitErr == nil:
			current.cmd = nil
			current.status = connFailed
			current.detail = "客户端已退出"
		default:
			current.cmd = nil
			current.status = connFailed
			current.detail = "客户端已退出：" + waitErr.Error()
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func (a *app) pumpLog(path string, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		a.handleLogLine(path, scanner.Text())
	}
}

func (a *app) handleLogLine(path, line string) {
	var status connStatus
	var detail string
	switch {
	case strings.Contains(line, "starting; server="):
		status, detail = connConnecting, "正在连接服务器…"
	case strings.Contains(line, "connected; serving requests"):
		status, detail = connConnected, "已连接"
	case strings.Contains(line, "disconnected:"):
		status = connReconnecting
		detail = strings.TrimSpace(line[strings.Index(line, "disconnected:")+len("disconnected:"):])
		detail = "连接断开：" + detail
	case strings.Contains(line, "reconnecting in"):
		status, detail = connReconnecting, "正在重连…"
	default:
		return
	}
	a.setConnIfPresent(path, status, detail)
}

func (a *app) setConn(path string, status connStatus, detail string) {
	a.mu.Lock()
	if conn := a.conns[path]; conn != nil {
		conn.status = status
		conn.detail = detail
	}
	a.mu.Unlock()
	a.invalidate()
}

func (a *app) setConnIfPresent(path string, status connStatus, detail string) {
	a.mu.Lock()
	conn := a.conns[path]
	if conn != nil && !conn.stopping {
		conn.status = status
		conn.detail = detail
	}
	a.mu.Unlock()
	a.invalidate()
}

func (a *app) stopConnection(path string) {
	a.mu.Lock()
	conn := a.conns[path]
	if conn == nil {
		a.mu.Unlock()
		return
	}
	conn.stopping = true
	cmd := conn.cmd
	conn.detail = "正在断开…"
	a.mu.Unlock()
	a.invalidate()

	if cmd == nil || cmd.Process == nil {
		a.mu.Lock()
		delete(a.conns, path)
		a.mu.Unlock()
		a.invalidate()
		return
	}
	if runtime.GOOS == "windows" {
		_ = cmd.Process.Kill()
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	time.AfterFunc(3*time.Second, func() { _ = cmd.Process.Kill() })
}

func (a *app) stopAll() {
	a.mu.Lock()
	paths := make([]string, 0, len(a.conns))
	for path := range a.conns {
		paths = append(paths, path)
	}
	a.mu.Unlock()
	for _, path := range paths {
		a.stopConnection(path)
	}
}

// --- view -------------------------------------------------------------------

func (a *app) view(c *ui.Context) {
	a.mu.Lock()
	servers := append([]serverEntry(nil), a.servers...)
	conns := make(map[string]connView, len(a.conns))
	for path, conn := range a.conns {
		conns[path] = connView{status: conn.status, detail: conn.detail, active: conn.cmd != nil}
	}
	busy, formMsg, formErr := a.busy, a.formMsg, a.formErr
	agentVersion, agentErr := a.agentVersion, a.agentErr
	labelHint := a.lastLabel
	toasts := a.pendingToasts
	a.pendingToasts = nil
	a.mu.Unlock()

	t := c.Theme()
	connected := 0
	for _, conn := range conns {
		if conn.status == connConnected {
			connected++
		}
	}

	versionLine := fmt.Sprintf("GUI v%s", guiVersion)
	if agentVersion != "" {
		versionLine += " · agent-client " + agentVersion
	} else {
		versionLine += " · agent-client 未找到"
	}

	ui.Column(c).Fill().Padding(18).Gap(12).Children(func() {
		// Header.
		ui.Row(c).AlignItems(ui.Center).Gap(10).Children(func() {
			ui.Column(c).Gap(2).Grow(1).Children(func() {
				ui.Text(c, "Agent Client GUI").FontSize(20).Bold()
				ui.Text(c, versionLine).FontSize(11).TextColor(t.TextMuted)
			})
			ui.Text(c, fmt.Sprintf("已连接 %d / %d", connected, len(servers))).FontSize(11).TextColor(t.TextMuted)
		})

		// Pair a server.
		ui.Column(c).Gap(8).Padding(12).Border(1, t.Border).Radius(t.Radius).Children(func() {
			ui.Text(c, "添加 / 配对服务器").Bold()
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.TextInput(c, &a.paste).
					Placeholder("粘贴配对命令或配对码，自动识别服务器地址…").
					Grow(1).
					OnChange(func() {
						if server, code := ParsePairingText(a.paste); server != "" || code != "" {
							if server != "" {
								a.address = server
							}
							if code != "" {
								a.code = code
							}
						}
					})
				ui.Button(c, "解析").OnClick(func() { a.applyParsed(a.paste) })
				ui.Button(c, "从剪贴板").OnClick(func() {
					text := c.ReadClipboard()
					if strings.TrimSpace(text) == "" {
						a.setForm("剪贴板里没有文本", true)
						return
					}
					a.paste = text
					a.applyParsed(text)
				})
			})
			ui.TextInput(c, &a.address).Label("服务器地址").Placeholder("http://10.99.9.7:30142").FillWidth()
			ui.TextInput(c, &a.code).Label("配对码").Placeholder("例如 3JFSG6").FillWidth()
			nameHint := "留空则沿用本机已保存的客户端名称"
			if labelHint != "" {
				nameHint = "留空则沿用本机已保存的名称：" + labelHint
			}
			ui.TextInput(c, &a.label).Label("客户端名称（可选）").Placeholder(nameHint).FillWidth()
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				ui.PrimaryButton(c, "配对并保存").Disabled(busy).OnClick(func() {
					a.startPair(a.address, a.code, a.label)
				})
				if busy {
					ui.Spinner(c)
				}
				if formMsg != "" {
					color := t.TextMuted
					if formErr {
						color = t.Danger
					}
					ui.Text(c, formMsg).FontSize(11).TextColor(color).Grow(1)
				}
			})
		})

		// Saved servers.
		ui.Row(c).AlignItems(ui.Center).Gap(8).Children(func() {
			ui.Text(c, fmt.Sprintf("服务器（%d）", len(servers))).Bold().Grow(1)
			ui.Button(c, "刷新列表").OnClick(a.refreshServers)
		})
		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).Gap(8).FillWidth().Children(func() {
				if len(servers) == 0 {
					ui.Text(c, "尚未配对任何服务器。把 pi-web「连接本地机器」的配对命令粘贴到上方即可。").
						FontSize(12).
						TextColor(t.TextMuted)
					return
				}
				for _, server := range servers {
					a.serverRow(c, server, conns[server.Path], t)
				}
			})
		})

		if agentErr != "" {
			ui.Text(c, agentErr).FontSize(11).TextColor(t.Danger)
		}
		ui.Text(c, "连接后可在 pi-web 的「连接本地机器」面板看到该机器；一个客户端可同时连接多个服务端。").
			FontSize(11).
			TextColor(t.TextMuted)
	})

	for _, toast := range toasts {
		c.AddToast(toast)
	}
}

func (a *app) serverRow(c *ui.Context, server serverEntry, conn connView, t *ui.Theme) {
	ui.Column(c).Gap(4).Padding(10).Border(1, t.Border).Radius(t.Radius).FillWidth().Children(func() {
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "●").FontSize(12).Width(14).TextColor(statusColor(t, conn.status, conn.active))
			ui.Column(c).Gap(1).Grow(1).Children(func() {
				ui.Text(c, server.Label).Bold()
				ui.Text(c, server.Server).FontSize(11).TextColor(t.TextMuted)
			})
			ui.Text(c, statusText(conn.status, conn.active)).FontSize(11).TextColor(statusColor(t, conn.status, conn.active))
			if conn.active {
				ui.Button(c, "断开").OnClick(func() { a.stopConnection(server.Path) })
			} else {
				ui.Button(c, "连接").OnClick(func() { a.startConnection(server) })
			}
		})
		if conn.detail != "" {
			ui.Text(c, conn.detail).FontSize(10).TextColor(t.TextMuted)
		}
		if server.WorkspaceRoot != "" {
			ui.Text(c, "工作区："+server.WorkspaceRoot).FontSize(10).TextColor(t.TextMuted)
		}
	})
}

func statusText(status connStatus, active bool) string {
	if status == connFailed {
		return "连接失败"
	}
	if !active {
		return "未连接"
	}
	switch status {
	case connConnected:
		return "已连接"
	case connReconnecting:
		return "重连中"
	default:
		return "连接中"
	}
}

func statusColor(t *ui.Theme, status connStatus, active bool) ui.Color {
	if status == connFailed {
		return t.Danger
	}
	if !active {
		return t.TextMuted
	}
	switch status {
	case connConnected:
		return t.Success
	default:
		return t.Warning
	}
}
