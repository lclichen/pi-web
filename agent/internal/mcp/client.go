// Package mcp hosts stdio MCP servers on the user's machine. The pi-web side
// acts as the MCP client (tool discovery and tool calls); this package only
// owns the process, the MCP initialize handshake, and JSON-RPC correlation.
//
// The relay connection is request/response oriented, so listTools and callTool
// are one-shot RPCs even though one process stays alive across calls. Server
// notifications are ignored; server-initiated requests (sampling/elicitation)
// get a method-not-found response in this version.
package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultTimeout = 60 * time.Second
	maxLineBytes   = 32 * 1024 * 1024
	maxStderrBytes = 16 * 1024
	maxTools       = 1000
)

// Config identifies one MCP server process. ServerKey must be unique per pi-web
// session/server pair; the same key with a different command/env restarts the
// process.
type Config struct {
	ServerKey     string
	Command       string
	Args          []string
	Env           map[string]string
	Dir           string
	ClientName    string
	ClientVersion string
}

func (c Config) hash() string {
	payload := struct {
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
		Dir     string            `json:"dir"`
	}{c.Command, c.Args, c.Env, c.Dir}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type session struct {
	cfg   Config
	hash  string
	cmd   *exec.Cmd
	stdin interface {
		Write([]byte) (int, error)
		Close() error
	}
	stdout    *bufio.Scanner
	stderr    *lockedBuffer
	writeMu   sync.Mutex
	mu        sync.Mutex
	nextID    int64
	pending   map[int64]chan rpcMessage
	done      chan struct{}
	finishOne sync.Once
	exitErr   error
}

// Manager owns long-lived stdio MCP processes.
type Manager struct {
	mu      sync.Mutex
	startMu sync.Mutex
	servers map[string]*session
}

func NewManager() *Manager {
	return &Manager{servers: make(map[string]*session)}
}

// Default is the process-wide host used by the relay dispatcher.
var Default = NewManager()

func (m *Manager) get(cfg Config, timeout time.Duration) (*session, error) {
	hash := cfg.hash()
	// Serialize starts so two concurrent tool calls cannot spawn duplicates.
	m.startMu.Lock()
	defer m.startMu.Unlock()

	m.mu.Lock()
	existing := m.servers[cfg.ServerKey]
	if existing != nil && existing.hash == hash && !existing.isClosed() {
		m.mu.Unlock()
		return existing, nil
	}
	m.mu.Unlock()
	if existing != nil {
		existing.close()
	}

	created, err := start(cfg, timeout)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if raced := m.servers[cfg.ServerKey]; raced != nil {
		m.mu.Unlock()
		created.close()
		return raced, nil
	}
	m.servers[cfg.ServerKey] = created
	m.mu.Unlock()
	return created, nil
}

// ListTools starts (or reuses) the process and returns its tools/list result.
func (m *Manager) ListTools(cfg Config, timeout time.Duration) ([]map[string]interface{}, error) {
	s, err := m.get(cfg, timeout)
	if err != nil {
		return nil, err
	}
	return s.listTools(timeout)
}

// CallTool sends one tools/call request to the process.
func (m *Manager) CallTool(
	cfg Config,
	name string,
	args map[string]interface{},
	meta map[string]interface{},
	timeout time.Duration,
) (map[string]interface{}, error) {
	s, err := m.get(cfg, timeout)
	if err != nil {
		return nil, err
	}
	return s.callTool(name, args, meta, timeout)
}

// Close terminates one session's MCP process. Missing keys are a no-op.
func (m *Manager) Close(serverKey string) bool {
	m.mu.Lock()
	s := m.servers[serverKey]
	delete(m.servers, serverKey)
	m.mu.Unlock()
	if s == nil {
		return false
	}
	s.close()
	return true
}

// CloseAll terminates every hosted process (agent shutdown / tests).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	servers := make([]*session, 0, len(m.servers))
	for key, s := range m.servers {
		delete(m.servers, key)
		servers = append(servers, s)
	}
	m.mu.Unlock()
	for _, s := range servers {
		s.close()
	}
}

func start(cfg Config, timeout time.Duration) (*session, error) {
	if strings.TrimSpace(cfg.ServerKey) == "" {
		return nil, fmt.Errorf("serverKey required")
	}
	if strings.TrimSpace(cfg.Command) == "" {
		return nil, fmt.Errorf("command required")
	}
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	cmd := exec.Command(cfg.Command, cfg.Args...)
	cmd.Dir = cfg.Dir
	cmd.Env = buildEnv(cfg.Env)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("MCP stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("MCP stdout: %w", err)
	}
	stderr := &lockedBuffer{max: maxStderrBytes}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start MCP server: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxLineBytes)
	s := &session{
		cfg:     cfg,
		hash:    cfg.hash(),
		cmd:     cmd,
		stdin:   stdin,
		stdout:  scanner,
		stderr:  stderr,
		pending: make(map[int64]chan rpcMessage),
		done:    make(chan struct{}),
	}
	go s.readLoop()
	go func() {
		waitErr := cmd.Wait()
		message := "MCP server exited"
		if waitErr != nil {
			message += ": " + waitErr.Error()
		}
		if tail := strings.TrimSpace(stderr.String()); tail != "" {
			message += ": " + tail
		}
		s.finish(errors.New(message))
	}()

	initParams := map[string]interface{}{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]interface{}{},
		"clientInfo": map[string]interface{}{
			"name":    firstNonEmpty(cfg.ClientName, "pi-web-relay"),
			"version": firstNonEmpty(cfg.ClientVersion, "1.0.0"),
		},
	}
	if _, err := s.request("initialize", initParams, timeout); err != nil {
		s.close()
		return nil, fmt.Errorf("MCP initialize: %w", err)
	}
	if err := s.notify("notifications/initialized", map[string]interface{}{}); err != nil {
		s.close()
		return nil, fmt.Errorf("MCP initialized notification: %w", err)
	}
	return s, nil
}

func (s *session) readLoop() {
	for s.stdout.Scan() {
		line := s.stdout.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		s.handleMessage(line)
	}
	if err := s.stdout.Err(); err != nil {
		s.finish(fmt.Errorf("read MCP stdout: %w", err))
	}
}

func (s *session) handleMessage(raw []byte) {
	var msg rpcMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	if len(msg.ID) == 0 {
		// Notifications (logging/progress/resources) are intentionally ignored.
		return
	}
	var id int64
	if err := json.Unmarshal(msg.ID, &id); err == nil {
		s.mu.Lock()
		ch := s.pending[id]
		if ch != nil {
			delete(s.pending, id)
		}
		s.mu.Unlock()
		if ch != nil {
			ch <- msg
			return
		}
	}
	if msg.Method != "" {
		// Server-initiated requests (sampling/elicitation) are unsupported.
		_ = s.write(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      msg.ID,
			"error": map[string]interface{}{
				"code":    -32601,
				"message": "pi-web relay MCP host does not support server-initiated requests",
			},
		})
	}
}

func (s *session) request(method string, params map[string]interface{}, timeout time.Duration) (json.RawMessage, error) {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	id := atomic.AddInt64(&s.nextID, 1)
	ch := make(chan rpcMessage, 1)
	s.mu.Lock()
	select {
	case <-s.done:
		err := s.exitError()
		s.mu.Unlock()
		return nil, err
	default:
	}
	s.pending[id] = ch
	s.mu.Unlock()

	payload := map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		payload["params"] = params
	}
	if err := s.write(payload); err != nil {
		s.removePending(id)
		return nil, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return nil, fmt.Errorf("MCP error %d: %s", msg.Error.Code, msg.Error.Message)
		}
		return msg.Result, nil
	case <-s.done:
		return nil, s.exitError()
	case <-timer.C:
		s.removePending(id)
		return nil, fmt.Errorf("MCP request timed out after %s: %s", timeout, method)
	}
}

func (s *session) notify(method string, params map[string]interface{}) error {
	payload := map[string]interface{}{"jsonrpc": "2.0", "method": method}
	if params != nil {
		payload["params"] = params
	}
	return s.write(payload)
}

func (s *session) write(payload interface{}) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.stdin.Write(append(raw, '\n')); err != nil {
		return err
	}
	return nil
}

func (s *session) removePending(id int64) {
	s.mu.Lock()
	delete(s.pending, id)
	s.mu.Unlock()
}

func (s *session) listTools(timeout time.Duration) ([]map[string]interface{}, error) {
	out := make([]map[string]interface{}, 0)
	cursor := ""
	for len(out) < maxTools {
		params := map[string]interface{}{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := s.request("tools/list", params, timeout)
		if err != nil {
			return nil, err
		}
		var result struct {
			Tools      []map[string]interface{} `json:"tools"`
			NextCursor string                   `json:"nextCursor"`
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &result); err != nil {
				return nil, fmt.Errorf("decode tools/list: %w", err)
			}
		}
		for _, tool := range result.Tools {
			name, _ := tool["name"].(string)
			if strings.TrimSpace(name) == "" {
				continue
			}
			out = append(out, tool)
			if len(out) >= maxTools {
				break
			}
		}
		if result.NextCursor == "" {
			break
		}
		cursor = result.NextCursor
	}
	return out, nil
}

func (s *session) callTool(
	name string,
	args map[string]interface{},
	meta map[string]interface{},
	timeout time.Duration,
) (map[string]interface{}, error) {
	params := map[string]interface{}{"name": name}
	if args == nil {
		args = map[string]interface{}{}
	}
	params["arguments"] = args
	if len(meta) > 0 {
		params["_meta"] = meta
	}
	raw, err := s.request("tools/call", params, timeout)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &result); err != nil {
			return nil, fmt.Errorf("decode tools/call: %w", err)
		}
	}
	if result == nil {
		result = map[string]interface{}{}
	}
	return result, nil
}

func (s *session) isClosed() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *session) close() {
	if s.stdin != nil {
		_ = s.stdin.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	s.finish(errors.New("MCP server closed"))
}

func (s *session) finish(err error) {
	s.finishOne.Do(func() {
		s.mu.Lock()
		s.exitErr = err
		pending := s.pending
		s.pending = make(map[int64]chan rpcMessage)
		s.mu.Unlock()
		close(s.done)
		for _, ch := range pending {
			select {
			case ch <- rpcMessage{Error: &rpcError{Code: -32000, Message: err.Error()}}:
			default:
			}
		}
	})
}

func (s *session) exitError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exitErr != nil {
		return s.exitErr
	}
	return errors.New("MCP server is not running")
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if b.max <= 0 {
		b.max = maxStderrBytes
	}
	if p = p[:min(len(p), b.max)]; b.buf.Len()+len(p) > b.max {
		keep := b.max - b.buf.Len()
		if keep > 0 {
			_, _ = b.buf.Write(p[:keep])
		}
	} else {
		_, _ = b.buf.Write(p)
	}
	return n, nil
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func buildEnv(extra map[string]string) []string {
	allowed := map[string]bool{
		"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true,
		"LANG": true, "TERM": true, "TMPDIR": true, "TMP": true, "TEMP": true,
		"SYSTEMROOT": true, "COMSPEC": true, "PATHEXT": true, "WINDIR": true,
		"APPDATA": true, "LOCALAPPDATA": true, "USERPROFILE": true,
		"HOMEDRIVE": true, "HOMEPATH": true, "PROGRAMDATA": true,
		"PROGRAMFILES": true, "PROGRAMFILES(X86)": true,
	}
	overridden := make(map[string]bool, len(extra))
	for key := range extra {
		overridden[strings.ToUpper(key)] = true
	}
	out := make([]string, 0, len(os.Environ())+len(extra))
	for _, kv := range os.Environ() {
		key := kv
		if idx := strings.IndexByte(kv, '='); idx >= 0 {
			key = kv[:idx]
		}
		upper := strings.ToUpper(key)
		if !allowed[upper] && !strings.HasPrefix(upper, "LC_") {
			continue
		}
		if overridden[upper] {
			continue
		}
		out = append(out, kv)
	}
	keys := make([]string, 0, len(extra))
	for key := range extra {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		out = append(out, key+"="+extra[key])
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
