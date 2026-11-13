package agent

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"time"

	"piagent/internal/config"
	"piagent/internal/workspace"
)

// connector is one live (or connecting) server connection, supervised by the
// interactive menu. Only ONE connection runs at a time in the CLI: the relay
// protocol and PTY bridge assume a single active websocket per process.
type connector struct {
	entry    *config.ServerConfig
	stop     chan struct{}
	done     chan struct{}
	onChange func()

	mu     sync.Mutex
	status string
}

func (c *connector) setStatus(status string) {
	c.mu.Lock()
	changed := c.status != status
	c.status = status
	c.mu.Unlock()
	// Repaint the status zone immediately; the user never has to press Enter
	// or l just to see "已连接".
	if changed && c.onChange != nil {
		c.onChange()
	}
}

func (c *connector) getStatus() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

func (c *connector) stopAndWait() {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
	}
}

// runInteractive is the default when stdin is a terminal: list saved servers,
// connect to the chosen one, and keep control (switch / new / disconnect /
// re-pair) instead of requiring a restart with different arguments. A real
// terminal gets three fixed zones (logs above, status, prompt); pipes and dumb
// terminals keep the plain line-oriented fallback.
func runInteractive(store *config.Store, rootOverride, version string, replace bool) int {
	reader := bufio.NewReader(os.Stdin)
	ui := newMenuUI(reader)
	ui.start()
	defer ui.stop()

	if dash, ok := ui.(*dashboard); ok {
		// Everything logged by the client (connect/reconnect/errors) belongs in
		// the log zone, not on top of the prompt.
		log.SetOutput(dash)
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt)
		go func() {
			<-sig
			ui.stop() // leave the alternate screen before dying
			os.Exit(130)
		}()
	}

	var active *connector
	stopActive := func() {
		if active != nil {
			active.stopAndWait()
			active = nil
			ui.invalidate()
		}
	}
	defer stopActive()

	for {
		entries := store.List()
		ui.refresh(entries, active)
		line, err := ui.ask("请选择（编号或 n/d/r/l/q）：")
		if err != nil {
			break
		}
		cmd := strings.ToLower(line)
		switch cmd {
		case "":
			continue
		case "l":
			continue
		case "d":
			if active == nil {
				ui.message("当前没有连接")
			} else {
				stopActive()
				ui.message("已断开")
			}
		case "q":
			stopActive()
			return 0
		case "n":
			entry, ok := promptNewConnection(ui, store, version, active)
			if !ok {
				continue
			}
			stopActive()
			ui.message("正在连接…")
			active = startConnector(store, entry, rootOverride, version, replace, ui.invalidate)
		case "r":
			idx, ok := readIndex(ui, entries)
			if !ok {
				continue
			}
			target := entries[idx]
			// Stop first: the relay refuses a re-pair while the machine is
			// connected (that rotation would invalidate this very connection).
			stopActive()
			code, _ := ui.ask(fmt.Sprintf("在 pi-web 生成配对码后输入（%s）：", target.Server))
			if code == "" {
				ui.message("已取消")
				continue
			}
			label := target.Label
			if name, _ := ui.ask(fmt.Sprintf("客户端名称 [%s]（留空沿用）：", target.Label)); name != "" {
				label = name
			}
			required, err := PairServer(store, target.Server, code, label, "", false, version)
			if err != nil {
				ui.message("重新配对失败：%v", err)
				continue
			}
			if required != "" {
				ui.message("client v%s; server requires >= %s", version, required)
			}
			ui.message("配对成功，正在连接…")
			active = startConnector(store, store.Get(target.Server), rootOverride, version, replace, ui.invalidate)
		default:
			n, err := strconv.Atoi(cmd)
			if err != nil || n < 1 || n > len(entries) {
				ui.message("无效选择")
				continue
			}
			target := entries[n-1]
			if active != nil && active.entry.Server == target.Server {
				ui.message("已经连接到该服务器")
				continue
			}
			stopActive()
			active = startConnector(store, target, rootOverride, version, replace, ui.invalidate)
		}
	}
	stopActive()
	return 0
}

// promptNewConnection walks through pairing a server that is not in the list
// yet (or refreshing one that is currently disconnected). The address prompt
// accepts a bare URL/host:port or the whole `agent-client pair --code … --server …`
// line from pi-web, so the common case is one paste plus Enter.
func promptNewConnection(ui menuUI, store *config.Store, version string, active *connector) (*config.ServerConfig, bool) {
	ui.message("新建连接（可直接粘贴 pi-web 里的整条 pair 命令）")
	line, err := ui.ask("服务器地址或命令（回车取消）：")
	if err != nil {
		return nil, false
	}
	server, code, label := parsePairInput(line)
	if server == "" {
		ui.message("已取消（未识别服务器地址）")
		return nil, false
	}
	if !strings.Contains(server, "://") {
		server = "http://" + server
	}
	existing := store.Get(server)
	if existing != nil && active != nil && active.entry.Server == existing.Server {
		ui.message("该服务器正在连接；如需重新配对请用 r。")
		return nil, false
	}
	if code == "" {
		code, _ = ui.ask("配对码（pi-web 生成）：")
		if code == "" {
			ui.message("已取消")
			return nil, false
		}
	}
	if label == "" {
		namePrompt := ""
		if existing != nil {
			namePrompt = existing.Label
		}
		if name, _ := ui.ask(fmt.Sprintf("客户端名称 [%s]（留空沿用）：", namePrompt)); name != "" {
			label = name
		}
	}
	required, err := PairServer(store, server, code, label, "", false, version)
	if err != nil {
		ui.message("配对失败：%v", err)
		return nil, false
	}
	entry := store.Get(server)
	if entry == nil {
		ui.message("配对失败：服务器未返回连接信息")
		return nil, false
	}
	if required != "" {
		ui.message("client v%s; server requires >= %s", version, required)
	}
	display := entry.Label
	if display == "" {
		display = "未命名"
	}
	ui.message("配对成功：%s（%s）", entry.Server, display)
	return entry, true
}

// parsePairInput extracts server/code/label from a pasted pairing command. A
// line without flags is treated as the relay address.
func parsePairInput(line string) (server, code, label string) {
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) == 0 {
		return "", "", ""
	}
	hasFlag := false
	for i := 0; i < len(fields); i++ {
		field := fields[i]
		name, value, hasValue := strings.Cut(field, "=")
		next := func() string {
			v := value
			if !hasValue {
				if i+1 >= len(fields) {
					return ""
				}
				i++
				v = fields[i]
			}
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
		switch name {
		case "--server", "-server":
			hasFlag = true
			server = next()
		case "--code", "-code":
			hasFlag = true
			code = next()
		case "--label", "-label":
			hasFlag = true
			label = next()
		}
	}
	if !hasFlag {
		return strings.TrimSpace(line), "", ""
	}
	return server, code, label
}

func readIndex(ui menuUI, entries []*config.ServerConfig) (int, bool) {
	if len(entries) == 0 {
		ui.message("没有已保存的连接；按 n 新建连接")
		return 0, false
	}
	value, _ := ui.ask(fmt.Sprintf("服务器编号 [1-%d]：", len(entries)))
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > len(entries) {
		ui.message("无效编号")
		return 0, false
	}
	return n - 1, true
}

func startConnector(store *config.Store, entry *config.ServerConfig, rootOverride, version string, replace bool, onChange func()) *connector {
	c := &connector{entry: entry, stop: make(chan struct{}), done: make(chan struct{}), onChange: onChange}
	if entry == nil {
		c.setStatus("连接不存在")
		close(c.done)
		return c
	}
	if _, err := store.EnsureMachineID(entry.Server); err != nil {
		log.Printf("warning: %v", err)
	}
	absRoot, note, err := resolveWorkspaceRoot(rootOverride, entry)
	if err != nil {
		c.setStatus(err.Error())
		close(c.done)
		return c
	}
	if note != "" {
		log.Printf("%s", note)
	}
	if entry.WorkspaceRoot == "" || !sameCleanPath(absRoot, entry.WorkspaceRoot) {
		entry.WorkspaceRoot = absRoot
		if err := store.Save(); err != nil {
			log.Printf("warning: could not persist workspace root %s: %v", absRoot, err)
		}
	}

	ws := &workspace.Workspace{Root: absRoot}
	info := buildInfo(version, ws.GetRoot(), entry)
	log.Printf("agent-client %s connecting; server=%s root=%s", version, entry.Server, absRoot)
	c.setStatus("连接中…")

	go func() {
		defer close(c.done)
		err := connectLoop(
			toWSURL(entry.Server, entry.Token),
			info, ws, store, entry, version, processInstanceID, replace, c.stop, c.setStatus,
		)
		if err == nil {
			c.setStatus("未连接")
			return
		}
		switch {
		case isTokenInvalid(err):
			c.setStatus("token 失效（按 r 重新配对）")
		case isDuplicateConnection(err):
			c.setStatus("已在其他客户端连接")
		default:
			c.setStatus("连接失败：" + err.Error())
		}
	}()
	return c
}
