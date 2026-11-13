// Package agent implements the persistent WebSocket client: it dials the
// pi-web relay, authenticates with the stored token, announces machine info,
// and serves RPC requests (fs.*, exec.*) scoped to a workspace root.
package agent

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"piagent/internal/config"
	"piagent/internal/protocol"
	"piagent/internal/pty"
	"piagent/internal/workspace"
)

// ptyMgr owns the live PTY sessions for the web terminal. Sessions OUTLIVE a
// brief relay disconnect: a NAT timeout used to kill every remote terminal.
// currentConn lets PTY goroutines emit on whichever connection is live.
var ptyMgr = pty.NewManager()

var currentConn atomic.Value // *safeConn

// emitEvent sends an unsolicited event frame on the CURRENT connection.
func emitEvent(event string, payload map[string]interface{}) {
	frame := map[string]interface{}{"type": "event", "event": event}
	for k, v := range payload {
		frame[k] = v
	}
	out, err := json.Marshal(frame)
	if err != nil {
		return
	}
	if sc, ok := currentConn.Load().(*safeConn); ok && sc != nil {
		_ = sc.writeText(out)
	}
}

// PTY sessions survive reconnects for up to this long before being reaped.
const ptyReapDelay = 5 * time.Minute

var (
	ptyReapMu    sync.Mutex
	ptyReapTimer *time.Timer
)

func schedulePtyReap() {
	ptyReapMu.Lock()
	defer ptyReapMu.Unlock()
	if ptyReapTimer != nil {
		ptyReapTimer.Stop()
	}
	ptyReapTimer = time.AfterFunc(ptyReapDelay, func() { ptyMgr.CloseAll() })
}

func cancelPtyReap() {
	ptyReapMu.Lock()
	defer ptyReapMu.Unlock()
	if ptyReapTimer != nil {
		ptyReapTimer.Stop()
		ptyReapTimer = nil
	}
}

func Run(args []string, version string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	configPath := fs.String("config", "", "path to config.json (default ~/.agent-client/config.json)")
	server := fs.String("server", "", "connect to one saved relay URL (see --list)")
	rootOverride := fs.String("root", "", "override workspace root (also for service units: WorkingDirectory may be /)")
	replace := fs.Bool("replace", false, "take over a connection that another client process holds for this machine")
	interactive := fs.Bool("interactive", false, "choose and control connections from a menu")
	list := fs.Bool("list", false, "list saved connections and exit")
	_ = fs.Parse(args)

	store, err := config.LoadStore(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent-client: load config failed: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run `./agent-client pair --code CODE --server URL` first.")
		return 2
	}
	if *list {
		printConnections(store, "")
		return 0
	}
	if *interactive || (*server == "" && isTerminal(os.Stdin)) {
		return runInteractive(store, *rootOverride, version, *replace)
	}
	entry := store.Resolve(*server)
	if entry == nil {
		if *server != "" {
			fmt.Fprintf(os.Stderr, "agent-client: no saved connection for %s\n", *server)
		} else {
			fmt.Fprintln(os.Stderr, "agent-client: several connections saved — pass --server URL (or run interactively):")
		}
		printConnections(store, "  ")
		return 2
	}
	return runOne(store, entry, *rootOverride, version, *replace)
}

// sameCleanPath compares two paths after making them absolute; case-insensitive
// on Windows.
func sameCleanPath(a, b string) bool {
	ca, errA := filepath.Abs(a)
	cb, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

// meaningfulCwd reports whether the process cwd is a user-chosen working
// directory rather than a service default (filesystem root or the home dir).
func meaningfulCwd() (string, bool) {
	cwd, err := os.Getwd()
	if err != nil || cwd == "" {
		return "", false
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", false
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return "", false
	}
	if filepath.Dir(abs) == abs { // "/" or "C:\\" — service cwd, not a workspace
		return "", false
	}
	// Same-file comparison avoids Windows short-name/case mismatches between
	// os.Getwd() and os.UserHomeDir().
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if hst, herr := os.Stat(home); herr == nil {
			if cst, cerr := os.Stat(abs); cerr == nil && os.SameFile(hst, cst) {
				return "", false
			}
		}
	}
	return abs, true
}

// resolveWorkspaceRoot decides which directory to share for one connection:
//  1. --root (must exist) — explicit, and the right choice for service units;
//  2. the process cwd when it is a user-chosen directory — starting the client
//     from another path switches the workspace there instead of resurrecting a
//     stale saved root;
//  3. the connection's saved workspaceRoot (service mode: cwd is / or home);
//  4. the home directory.
//
// Returns a human-readable note when a saved root was ignored or missing.
func resolveWorkspaceRoot(flagRoot string, entry *config.ServerConfig) (string, string, error) {
	if flagRoot != "" {
		abs, err := filepath.Abs(flagRoot)
		if err != nil {
			return "", "", fmt.Errorf("bad --root %q: %w", flagRoot, err)
		}
		if st, err := os.Stat(abs); err != nil || !st.IsDir() {
			return "", "", fmt.Errorf("--root %s is not an existing directory", abs)
		}
		return abs, "", nil
	}
	if cwd, ok := meaningfulCwd(); ok {
		note := ""
		if entry.WorkspaceRoot != "" && !sameCleanPath(entry.WorkspaceRoot, cwd) {
			note = fmt.Sprintf(
				"workspace root is %s (ignoring saved root %s because the client was started here)",
				cwd, entry.WorkspaceRoot,
			)
		}
		return cwd, note, nil
	}
	note := ""
	if entry.WorkspaceRoot != "" {
		if abs, err := filepath.Abs(entry.WorkspaceRoot); err == nil {
			if st, statErr := os.Stat(abs); statErr == nil && st.IsDir() {
				return abs, "", nil
			}
		}
		note = fmt.Sprintf("saved workspace root %s no longer exists; falling back", entry.WorkspaceRoot)
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if st, statErr := os.Stat(home); statErr == nil && st.IsDir() {
			return home, note, nil
		}
	}
	return "", note, fmt.Errorf("cannot determine a workspace root; pass --root PATH")
}

func buildInfo(version, root string, entry *config.ServerConfig) protocol.AgentInfo {
	host, _ := os.Hostname()
	return protocol.AgentInfo{
		Hostname:      host,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		WorkspaceRoot: root,
		AgentVersion:  version,
		MachineID:     entry.MachineID,
		Label:         entry.Label,
		Features:      []string{protocol.FeatureWorkspaceBase, protocol.FeatureBinaryRead, protocol.FeatureBinaryWrite},
	}
}

// toWSURL converts the relay base URL (http(s)://host:port) into a token-bearing
// WebSocket URL (ws(s)://host:port/ws?token=...).
func toWSURL(server, token string) string {
	base := strings.TrimRight(server, "/")
	u, err := url.Parse(base + "/ws")
	if err != nil {
		return fmt.Sprintf("%s?token=%s", base+"/ws", url.QueryEscape(token))
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	}
	u.Path = "/ws"
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String()
}

func connectLoop(
	wsURL string,
	info protocol.AgentInfo,
	ws *workspace.Workspace,
	store *config.Store,
	entry *config.ServerConfig,
	version, instanceID string,
	replace bool,
	stop <-chan struct{},
	onStatus func(string),
) error {
	backoff := time.Second
	const maxBackoff = 30 * time.Second
	// A connection that stayed up for a while is a healthy link: the next drop
	// is a fresh incident, not a continuing outage — reset the backoff instead
	// of making the user wait 30s after every network blip.
	const healthyConn = 30 * time.Second
	for {
		select {
		case <-stop:
			return nil
		default:
		}
		start := time.Now()
		err := serveOnce(wsURL, info, ws, store, entry, version, instanceID, replace, stop, onStatus)
		if err != nil {
			switch {
			case errors.Is(err, errTokenInvalid):
				onStatus("token 失效")
				return err
			case errors.Is(err, errDuplicateConnection):
				onStatus("已在其他客户端连接")
				return err
			case errors.Is(err, errStopped):
				return nil
			}
			log.Printf("disconnected: %v", err)
		}
		if time.Since(start) >= healthyConn {
			backoff = time.Second
		}
		log.Printf("reconnecting in %s ...", backoff)
		onStatus(fmt.Sprintf("重连中（%s 后）", backoff))
		select {
		case <-stop:
			return nil
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// safeConn serializes WebSocket writes (gorilla/websocket forbids concurrent
// writers). Reads are single-threaded in serveOnce.
type safeConn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (s *safeConn) writeText(b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.c.WriteMessage(websocket.TextMessage, b)
}

func (s *safeConn) ping() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.c.WriteControl(websocket.PingMessage, nil, time.Now().Add(pingTimeout))
}

// isMethod reports whether the frame is a request for the given method.
func isMethod(msg []byte, method string) bool {
	var probe struct {
		Method string `json:"method"`
	}
	return json.Unmarshal(msg, &probe) == nil && probe.Method == method
}

const (
	pingInterval = 25 * time.Second
	pingTimeout  = 5 * time.Second
	pongGrace    = 60 * time.Second
)

// keepalive pings the relay so idle connections survive NAT/firewall
// timeouts. A failed ping or a stale pong closes the socket, failing the read
// loop in serveOnce, which triggers the reconnect loop. Writes go through the
// safeConn mutex (gorilla forbids concurrent writers).
func keepalive(sc *safeConn, lastPong *atomic.Int64) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := sc.ping(); err != nil {
			_ = sc.c.Close()
			return
		}
		if time.Since(time.Unix(lastPong.Load(), 0)) > pongGrace {
			_ = sc.c.Close()
			return
		}
	}
}

func handleRequest(sc *safeConn, msg []byte, ws *workspace.Workspace) {
	var req protocol.Request
	if err := json.Unmarshal(msg, &req); err != nil {
		return
	}
	// exec.stream emits incremental chunk frames then a terminal end frame.
	if req.Method == "exec.stream" {
		handleStreamRequest(sc, req, ws)
		return
	}
	// pty.* manage interactive terminals; the agent pushes unsolicited
	// pty.output "event" frames as the PTY produces output.
	if strings.HasPrefix(req.Method, "pty.") {
		handlePtyRequest(sc, req, ws)
		return
	}
	resp := dispatch(req, ws)
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_ = sc.writeText(out)
}

func handleStreamRequest(sc *safeConn, req protocol.Request, ws *workspace.Workspace) {
	emit := func(stream, text string) {
		frame, _ := json.Marshal(map[string]interface{}{
			"id":   req.ID,
			"type": "chunk",
			"data": map[string]string{"stream": stream, "text": text},
		})
		_ = sc.writeText(frame)
	}
	exitCode, err := func() (int, error) {
		view, verr := ws.For(req.Params)
		if verr != nil {
			return -1, verr
		}
		return view.ExecStream(req.Params, emit)
	}()

	end := map[string]interface{}{"id": req.ID, "type": "end"}
	if err != nil {
		end["ok"] = false
		end["error"] = err.Error()
	} else {
		end["ok"] = true
		end["result"] = map[string]interface{}{"exitCode": exitCode}
	}
	out, _ := json.Marshal(end)
	_ = sc.writeText(out)
}

// handlePtyRequest serves pty.create/input/resize/close. PTY output and exit
// events are pushed asynchronously as unsolicited {type:"event", ...} frames
// (no request id) — the relay routes these to the per-session SSE subscriber.
func handlePtyRequest(sc *safeConn, req protocol.Request, ws *workspace.Workspace) {
	_ = sc // responses go through the caller; events go via emitEvent/currentConn

	var result interface{}
	var perr error
	switch req.Method {
	case "pty.create":
		view, verr := ws.For(req.Params)
		if verr != nil {
			perr = verr
			break
		}
		shell := paramString(req.Params, "shell", defaultShell())
		absCwd, e := view.Resolve(paramString(req.Params, "cwd", "."))
		if e != nil {
			perr = e
			break
		}
		cols := paramInt(req.Params, "cols", 80)
		rows := paramInt(req.Params, "rows", 24)
		sess, e := ptyMgr.Create(shell, absCwd, cols, rows,
			func(sessionID, data string) {
				emitEvent("pty.output", map[string]interface{}{"sessionId": sessionID, "data": data})
			},
			func(sessionID string, code int) {
				emitEvent("pty.exit", map[string]interface{}{"sessionId": sessionID, "code": code})
			},
		)
		if e != nil {
			perr = e
			break
		}
		result = map[string]interface{}{"sessionId": sess.ID}
	case "pty.input":
		sess, ok := ptyMgr.Get(paramString(req.Params, "sessionId", ""))
		if !ok {
			perr = fmt.Errorf("unknown pty session")
			break
		}
		perr = sess.Write([]byte(paramString(req.Params, "data", "")))
		result = map[string]interface{}{"ok": true}
	case "pty.resize":
		sess, ok := ptyMgr.Get(paramString(req.Params, "sessionId", ""))
		if !ok {
			perr = fmt.Errorf("unknown pty session")
			break
		}
		perr = sess.Resize(paramInt(req.Params, "cols", 80), paramInt(req.Params, "rows", 24))
		result = map[string]interface{}{"ok": true}
	case "pty.close":
		ptyMgr.Close(paramString(req.Params, "sessionId", ""))
		result = map[string]interface{}{"ok": true}
	default:
		perr = fmt.Errorf("unknown pty method: %s", req.Method)
	}

	resp := protocol.Response{ID: req.ID}
	if perr != nil {
		resp.OK = false
		resp.Error = perr.Error()
	} else {
		resp.OK = true
		resp.Result = result
	}
	out, _ := json.Marshal(resp)
	_ = sc.writeText(out)
}

func defaultShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}

func paramString(params map[string]interface{}, key, dflt string) string {
	if params == nil {
		return dflt
	}
	if v, ok := params[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return dflt
}

func paramInt(params map[string]interface{}, key string, dflt int) int {
	if params == nil {
		return dflt
	}
	if v, ok := params[key]; ok {
		if n, ok := v.(float64); ok {
			return int(n)
		}
	}
	return dflt
}

func dispatch(req protocol.Request, ws *workspace.Workspace) protocol.Response {
	result, err := callMethod(req.Method, req.Params, ws)
	if err != nil {
		return protocol.Response{ID: req.ID, OK: false, Error: err.Error()}
	}
	return protocol.Response{ID: req.ID, OK: true, Result: result}
}

func callMethod(method string, params map[string]interface{}, ws *workspace.Workspace) (interface{}, error) {
	// Per-request root: an optional absolute `base` scopes this call to the
	// project workspace (see workspace.For). Absent = the agent-wide root.
	view, err := ws.For(params)
	if err != nil {
		return nil, err
	}
	switch method {
	case "workspace.info":
		host, _ := os.Hostname()
		return map[string]interface{}{
			"hostname": host,
			"os":       runtime.GOOS,
			"arch":     runtime.GOARCH,
		}, nil
	case "fs.list":
		return view.List(params)
	case "fs.read":
		return view.Read(params)
	case "fs.write":
		return view.Write(params)
	case "fs.stat":
		return view.Stat(params)
	case "fs.mkdir":
		return view.Mkdir(params)
	case "fs.delete":
		return view.Delete(params)
	case "fs.rename":
		return view.Rename(params)
	case "search.grep":
		return view.Grep(params)
	case "search.fd":
		return view.Fd(params)
	case "exec.run":
		return view.Exec(params)
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}
