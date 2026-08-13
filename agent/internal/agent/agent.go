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
	"time"

	"github.com/gorilla/websocket"

	"piagent/internal/config"
	"piagent/internal/protocol"
	"piagent/internal/workspace"
)

// Run is the `pi-agent run` (default) subcommand. It never returns under normal
// operation — it reconnects forever with backoff.
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
