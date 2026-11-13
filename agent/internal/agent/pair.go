package agent

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"piagent/internal/config"
)

// RunPair is the `agent-client pair` subcommand: exchange a pairing code for a
// long-lived token and store it in the single config file, keyed by server.
func RunPair(args []string, version string) int {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	code := fs.String("code", "", "pairing code shown in pi-web (required)")
	server := fs.String("server", "", "relay URL, e.g. http://host:30142 (required)")
	root := fs.String("root", "", "workspace root to share (default: current dir at run time)")
	label := fs.String("label", "", "machine label shown in pi-web, e.g. --label 工位机")
	configPath := fs.String("config", "", "path to config.json (default ~/.agent-client/config.json)")
	force := fs.Bool("force", false, "rotate the token even if this machine is currently connected")
	_ = fs.Parse(args)

	if *code == "" || *server == "" {
		fmt.Fprintln(os.Stderr, "usage: ./agent-client pair --code CODE --server URL [--root PATH] [--label NAME] [--force]")
		return 2
	}
	store, err := config.LoadStore(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pair: %v\n", err)
		return 1
	}
	required, err := PairServer(store, *server, *code, *label, *root, *force, version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pair failed: %v\n", err)
		return 1
	}
	if required != "" {
		fmt.Printf("client v%s; server requires >= %s\n", version, required)
	}
	entry := store.Get(*server)
	if entry == nil {
		fmt.Fprintln(os.Stderr, "pair: the server did not return credentials")
		return 1
	}
	fmt.Printf("paired with %s (machine %s)\n", entry.Server, entry.MachineID)
	fmt.Println("token saved to", store.Path())
	if len(store.Servers) > 1 {
		fmt.Printf("next: ./agent-client run --server %s\n", entry.Server)
		fmt.Println("      (or run ./agent-client run to pick from the list)")
	} else {
		fmt.Println("next: ./agent-client run   (or: systemctl start agent-client)")
	}
	return 0
}

// PairServer exchanges a pairing code and saves the credentials for one server.
// A label is only written when non-empty, so leaving it out keeps the machine's
// existing name. force lets a re-pair rotate the token while this machine is
// connected (the relay closes the old connection). The returned string is the
// server's minimum client version ("" when not advertised) so the caller can
// display it through the right UI.
func PairServer(store *config.Store, server, code, label, root string, force bool, version string) (string, error) {
	server = strings.TrimRight(strings.TrimSpace(server), "/")
	code = strings.TrimSpace(code)
	if server == "" || code == "" {
		return "", fmt.Errorf("server and code are required")
	}
	existing := store.Get(server)
	machineID := ""
	if existing != nil {
		machineID = existing.MachineID
	}
	if machineID == "" {
		id, err := config.NewMachineID()
		if err != nil {
			return "", err
		}
		machineID = id
	}
	hostname, _ := os.Hostname()

	body, _ := json.Marshal(map[string]any{
		"code":          code,
		"machineId":     machineID,
		"hostname":      hostname,
		"label":         strings.TrimSpace(label),
		"clientVersion": version,
		"force":         force,
	})
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Post(server+"/pair/exchange", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("pair request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		return "", httpErrorMessage(resp.StatusCode, respBody)
	}

	var out struct {
		Token           string `json:"token"`
		WsPath          string `json:"wsPath"`
		MachineID       string `json:"machineId"`
		RequiredVersion string `json:"requiredVersion"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil || out.Token == "" {
		return "", fmt.Errorf("bad response: %s", string(respBody))
	}

	entry := existing
	if entry == nil {
		entry = &config.ServerConfig{Server: server}
	}
	entry.Token = out.Token
	if out.MachineID != "" {
		entry.MachineID = out.MachineID
	} else {
		entry.MachineID = machineID
	}
	if label = strings.TrimSpace(label); label != "" {
		entry.Label = label
	}
	if root = strings.TrimSpace(root); root != "" {
		entry.WorkspaceRoot = root
	}
	store.Set(entry)
	if err := store.Save(); err != nil {
		return "", fmt.Errorf("save config: %w", err)
	}
	return out.RequiredVersion, nil
}

// httpErrorMessage turns the relay's structured pair errors into something a
// user can act on.
func httpErrorMessage(status int, body []byte) error {
	var payload struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(body, &payload)
	switch {
	case status == http.StatusConflict && payload.Code == "machine-connected":
		return fmt.Errorf("该机器已有客户端连接；请先停止它再配对（或用 --force 强制轮换）")
	case status == http.StatusUnauthorized:
		return fmt.Errorf("配对码无效或已过期，请在 pi-web 重新生成")
	case status == http.StatusTooManyRequests:
		return fmt.Errorf("尝试过于频繁，请稍后再试")
	default:
		if payload.Error != "" {
			return fmt.Errorf("%s (HTTP %d)", payload.Error, status)
		}
		return fmt.Errorf("HTTP %d: %s", status, strings.TrimSpace(string(body)))
	}
}
