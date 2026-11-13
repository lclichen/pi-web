package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"piagent/internal/config"
	"piagent/internal/protocol"
	"piagent/internal/workspace"
)

// The relay closes the socket with a specific HTTP status for two conditions
// that retrying cannot fix: the token no longer authenticates (401) and the
// machine is already connected from another client (409). Run reports them
// instead of reconnect-looping forever.
var (
	errTokenInvalid        = errors.New("token invalid or expired")
	errDuplicateConnection = errors.New("machine already connected elsewhere")
	errStopped             = errors.New("stopped")
)

// duplicateConnectionError carries the live holder's identity from the relay's
// 409 body so the user can tell WHICH client to stop.
type duplicateConnectionError struct{ holder string }

func (e *duplicateConnectionError) Error() string { return e.holder }
func (e *duplicateConnectionError) Unwrap() error { return errDuplicateConnection }

func parseConflict(body []byte) error {
	var payload struct {
		Connection struct {
			Hostname     string `json:"hostname"`
			AgentVersion string `json:"agentVersion"`
		} `json:"connection"`
	}
	holder := ""
	if json.Unmarshal(body, &payload) == nil && payload.Connection.Hostname != "" {
		holder = payload.Connection.Hostname
		if payload.Connection.AgentVersion != "" {
			holder += "，v" + payload.Connection.AgentVersion
		}
	}
	if holder == "" {
		holder = strings.TrimSpace(string(body))
	}
	return &duplicateConnectionError{holder: holder}
}

// processInstanceID identifies this running client process. A reconnect of the
// SAME process may replace its own previous connection; a second process with
// a different id is refused by the relay while the first is alive.
var processInstanceID = func() string {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("p%d", os.Getpid())
	}
	return hex.EncodeToString(raw)
}()

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func printConnections(store *config.Store, indent string) {
	entries := store.List()
	if len(entries) == 0 {
		fmt.Printf("%s(没有已保存的连接；先运行 ./agent-client pair --code CODE --server URL)\n", indent)
		return
	}
	for i, entry := range entries {
		label := entry.Label
		if label == "" {
			label = "未命名"
		}
		current := ""
		if entry.Server == store.Current {
			current = " *"
		}
		fmt.Printf("%s[%d] %s  %s%s\n", indent, i+1, entry.Server, label, current)
	}
}

// runOne connects to one saved server and blocks until the connection ends
// (token/duplicate failure) or the process exits.
func runOne(store *config.Store, entry *config.ServerConfig, rootOverride, version string, replace bool) int {
	if entry.Token == "" {
		fmt.Fprintf(os.Stderr, "agent-client: %s has no token; pair it again:\n  ./agent-client pair --code CODE --server %s\n", entry.Server, entry.Server)
		return 2
	}
	// Stable machine identity for multi-machine relays; generates + persists on
	// first run. Failure is non-fatal (identity regenerates next start).
	if _, err := store.EnsureMachineID(entry.Server); err != nil {
		log.Printf("warning: %v", err)
	}

	absRoot, note, err := resolveWorkspaceRoot(rootOverride, entry)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent-client: %v\n", err)
		return 2
	}
	if note != "" {
		log.Printf("%s", note)
	}
	// Persist the resolved root so restarts (and the WebUI, via hello) always
	// see the directory this run actually serves — a deleted saved root
	// self-heals instead of being re-announced forever.
	if entry.WorkspaceRoot == "" || !sameCleanPath(absRoot, entry.WorkspaceRoot) {
		entry.WorkspaceRoot = absRoot
		if err := store.Save(); err != nil {
			log.Printf("warning: could not persist workspace root %s: %v", absRoot, err)
		}
	}

	ws := &workspace.Workspace{Root: absRoot}
	info := buildInfo(version, ws.GetRoot(), entry)
	log.Printf("agent-client %s starting; server=%s root=%s os=%s/%s",
		version, entry.Server, absRoot, runtime.GOOS, runtime.GOARCH)

	err = connectLoop(toWSURL(entry.Server, entry.Token), info, ws, store, entry, version, processInstanceID, replace, make(chan struct{}), func(string) {})
	if err == nil {
		return 0
	}
	switch {
	case errors.Is(err, errTokenInvalid):
		fmt.Fprintf(os.Stderr,
			"agent-client: token 无效或已过期（服务器拒绝连接）。重新配对即可，无需删除客户端：\n  ./agent-client pair --code CODE --server %s\n",
			entry.Server)
	case errors.Is(err, errDuplicateConnection):
		holder := ""
		var dup *duplicateConnectionError
		if errors.As(err, &dup) && dup.holder != "" {
			holder = "（" + dup.holder + "）"
		}
		fmt.Fprintf(os.Stderr,
			"agent-client: 该机器已在另一个客户端连接%s。请先停止那个客户端；确需接管请加 --replace。\n", holder)
	default:
		fmt.Fprintf(os.Stderr, "agent-client: connection failed: %v\n", err)
	}
	return 2
}

func serveOnce(
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
	headers := http.Header{}
	if instanceID != "" {
		headers.Set("X-Agent-Instance", instanceID)
	}
	if replace {
		headers.Set("X-Agent-Replace", "1")
	}
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, headers)
	if err != nil {
		status := 0
		var body []byte
		if resp != nil {
			status = resp.StatusCode
			body, _ = io.ReadAll(io.LimitReader(resp.Body, 1024))
			_ = resp.Body.Close()
		}
		switch status {
		case http.StatusUnauthorized:
			return errTokenInvalid
		case http.StatusConflict:
			return parseConflict(body)
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	sc := &safeConn{c: conn}
	// PTY sessions live across reconnects (see schedulePtyReap): point the
	// emitters at THIS connection and cancel any pending reap from the
	// previous disconnect; on exit, schedule one.
	currentConn.Store(sc)
	cancelPtyReap()
	defer schedulePtyReap()

	// Closing the socket is how disconnect() interrupts the blocking read.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-stop:
			_ = conn.Close()
		case <-done:
		}
	}()

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
	if onStatus != nil {
		onStatus("已连接")
	}

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			if isClosed(stop) {
				return errStopped
			}
			return fmt.Errorf("read: %w", err)
		}
		// workspace.set-root needs the write side (to re-announce hello with
		// the new root), so handle it inline rather than in a goroutine.
		if isMethod(msg, "workspace.set-root") {
			go func() {
				resp := handleSetRoot(msg, ws, store, entry)
				out, _ := json.Marshal(resp)
				_ = sc.writeText(out)
				if resp.OK {
					// Re-announce so the relay's registry info reflects the new
					// root immediately (the web UI reads it from the hello).
					hello, _ := json.Marshal(protocol.Hello{Type: "hello", Info: buildInfo(version, ws.GetRoot(), entry)})
					_ = sc.writeText(hello)
					log.Printf("workspace root changed to %s", ws.GetRoot())
				}
			}()
			continue
		}
		go handleRequest(sc, msg, ws)
	}
}

func isClosed(stop <-chan struct{}) bool {
	select {
	case <-stop:
		return true
	default:
		return false
	}
}

func isTokenInvalid(err error) bool {
	return errors.Is(err, errTokenInvalid)
}

func isDuplicateConnection(err error) bool {
	return errors.Is(err, errDuplicateConnection)
}

// handleSetRoot validates and hot-swaps the workspace root for ONE connection
// and persists it to that connection's entry.
func handleSetRoot(msg []byte, ws *workspace.Workspace, store *config.Store, entry *config.ServerConfig) protocol.Response {
	var req protocol.Request
	if err := json.Unmarshal(msg, &req); err != nil {
		return protocol.Response{OK: false, Error: err.Error()}
	}
	path, _ := req.Params["path"].(string)
	if path == "" {
		return protocol.Response{ID: req.ID, OK: false, Error: "path required"}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return protocol.Response{ID: req.ID, OK: false, Error: err.Error()}
	}
	st, statErr := os.Stat(abs)
	if statErr != nil || !st.IsDir() {
		return protocol.Response{ID: req.ID, OK: false, Error: fmt.Sprintf("not a directory: %s", abs)}
	}
	ws.SetRoot(abs)
	entry.WorkspaceRoot = abs
	if err := store.Save(); err != nil {
		return protocol.Response{ID: req.ID, OK: false, Error: "root applied but save failed: " + err.Error()}
	}
	return protocol.Response{ID: req.ID, OK: true, Result: map[string]interface{}{"root": abs}}
}
