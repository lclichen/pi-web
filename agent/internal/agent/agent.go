// Package agent implements the persistent WebSocket client: it dials the
// pi-web relay, authenticates with the stored token, announces machine info,
// and serves RPC requests (fs.*, exec.*) scoped to a workspace root.
package agent

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
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
	"piagent/internal/pty"
	"piagent/internal/protocol"
	"piagent/internal/workspace"
)

// ptyMgr owns the live PTY sessions for the web terminal. Tied to a single
// relay connection: cleared on disconnect/reconnect.
var ptyMgr = pty.NewManager()
func Run(args []string, version string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	configPath := fs.String("config", "", "path to config.json (default ~/.pi-agent/config.json)")
	rootOverride := fs.String("root", "", "override workspace root")
	_ = fs.Parse(args)

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pi-agent: load config failed: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run `pi-agent pair --code CODE --server URL` first.")
		return 2
	}
	if cfg.Server == "" || cfg.Token == "" {
		fmt.Fprintln(os.Stderr, "pi-agent: config missing server/token; pair first.")
		return 2
	}

	root := *rootOverride
	if root == "" {
		root = cfg.WorkspaceRoot
	}
	if root == "" {
		if cwd, err := os.Getwd(); err == nil {
			root = cwd
		} else if home, err := os.UserHomeDir(); err == nil {
			root = home
		}
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pi-agent: bad root %q: %v\n", root, err)
		return 2
	}

	ws := &workspace.Workspace{Root: absRoot}
	info := buildInfo(version, absRoot)
	log.Printf("pi-agent %s starting; server=%s root=%s os=%s/%s",
		version, cfg.Server, absRoot, runtime.GOOS, runtime.GOARCH)

	connectLoop(toWSURL(cfg.Server, cfg.Token), info, ws)
	return 0
}

func buildInfo(version, root string) protocol.AgentInfo {
	host, _ := os.Hostname()
	return protocol.AgentInfo{
		Hostname:      host,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		WorkspaceRoot: root,
		AgentVersion:  version,
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

func connectLoop(wsURL string, info protocol.AgentInfo, ws *workspace.Workspace) {
	backoff := time.Second
	const maxBackoff = 30 * time.Second
	for {
		if err := serveOnce(wsURL, info, ws); err != nil {
			log.Printf("disconnected: %v", err)
		}
		log.Printf("reconnecting in %s ...", backoff)
		time.Sleep(backoff)
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

func serveOnce(wsURL string, info protocol.AgentInfo, ws *workspace.Workspace) error {
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, http.Header{})
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	sc := &safeConn{c: conn}
	// PTY sessions are bound to this connection; tear them down on disconnect so
	// they don't leak (and don't write to a dead socket after reconnect).
	defer ptyMgr.CloseAll()

	// Idle connections get silently cut by NATs/firewalls; without a heartbeat
	// the agent only notices on the next write. Ping every 25s and drop the
	// socket if the pong falls behind — the read loop then errors out and the
	// outer loop reconnects.
	//
	// SetPongHandler must be called from the same goroutine as ReadMessage
	// (gorilla/websocket treats it as a read method; concurrent calls race the
	// handler field and the pong is silently dropped).
	var lastPong atomic.Int64
	lastPong.Store(time.Now().Unix())
	conn.SetPongHandler(func(string) error {
		lastPong.Store(time.Now().Unix())
		return nil
	})
	go keepalive(sc, &lastPong)

	hello, _ := json.Marshal(protocol.Hello{Type: "hello", Info: info})
	if err := sc.writeText(hello); err != nil {
		return fmt.Errorf("write hello: %w", err)
	}
	log.Printf("connected; serving requests")

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		go handleRequest(sc, msg, ws)
	}
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
	exitCode, err := ws.ExecStream(req.Params, emit)

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

// handlePtyRequest serves pty.create/input/resize/close. PTY output is pushed
// asynchronously as unsolicited {type:"event", event:"pty.output", ...} frames
// (no request id) — the relay routes these to the per-session SSE subscriber.
func handlePtyRequest(sc *safeConn, req protocol.Request, ws *workspace.Workspace) {
	emit := func(event string, payload map[string]interface{}) {
		frame := map[string]interface{}{"type": "event", "event": event}
		for k, v := range payload {
			frame[k] = v
		}
		out, _ := json.Marshal(frame)
		_ = sc.writeText(out)
	}

	var result interface{}
	var perr error
	switch req.Method {
	case "pty.create":
		shell := paramString(req.Params, "shell", defaultShell())
		absCwd, e := ws.Resolve(paramString(req.Params, "cwd", "."))
		if e != nil {
			perr = e
			break
		}
		cols := paramInt(req.Params, "cols", 80)
		rows := paramInt(req.Params, "rows", 24)
		sess, e := ptyMgr.Create(shell, absCwd, cols, rows, func(sessionID, data string) {
			emit("pty.output", map[string]interface{}{"sessionId": sessionID, "data": data})
		})
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
	switch method {
	case "workspace.info":
		host, _ := os.Hostname()
		return map[string]interface{}{
			"hostname": host,
			"os":       runtime.GOOS,
			"arch":     runtime.GOARCH,
		}, nil
	case "fs.list":
		return ws.List(params)
	case "fs.read":
		return ws.Read(params)
	case "fs.write":
		return ws.Write(params)
	case "fs.stat":
		return ws.Stat(params)
	case "fs.mkdir":
		return ws.Mkdir(params)
	case "fs.delete":
		return ws.Delete(params)
	case "fs.rename":
		return ws.Rename(params)
	case "search.grep":
		return ws.Grep(params)
	case "search.fd":
		return ws.Fd(params)
	case "exec.run":
		return ws.Exec(params)
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}
