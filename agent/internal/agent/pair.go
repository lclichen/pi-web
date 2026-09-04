package agent

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"piagent/internal/config"
)

// RunPair is the `pi-agent pair` subcommand: exchange a pairing code for a
// long-lived token and persist it.
func RunPair(args []string, version string) int {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	code := fs.String("code", "", "pairing code shown in pi-web (required)")
	server := fs.String("server", "", "relay URL, e.g. http://host:30142 (required)")
	root := fs.String("root", "", "workspace root to share (default: current dir)")
	label := fs.String("label", "", "machine label shown in pi-web, e.g. --label 工位机")
	configPath := fs.String("config", "", "path to write config.json (default ~/.pi-agent/config.json)")
	_ = fs.Parse(args)

	if *code == "" || *server == "" {
		fmt.Fprintln(os.Stderr, "usage: pi-agent pair --code CODE --server URL [--root PATH] [--label NAME]")
		return 2
	}

	// Pre-existing config (re-pair keeps the same machine identity); otherwise
	// a fresh config with a freshly generated id.
	cfg := &config.Config{}
	cfg.SetPath(*configPath)
	if loaded, err := config.Load(*configPath); err == nil {
		cfg = loaded
	}
	machineID, err := cfg.EnsureMachineID()
	if err != nil {
		fmt.Fprintf(os.Stderr, "pair: %v\n", err)
		return 1
	}
	hostname, _ := os.Hostname()

	body, _ := json.Marshal(map[string]string{
		"code":      *code,
		"machineId": machineID,
		"hostname":  hostname,
		"label":     *label,
	})
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(*server+"/pair/exchange", "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "pair request failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "pair failed (HTTP %d): %s\n", resp.StatusCode, string(respBody))
		return 1
	}

	var out struct {
		Token     string `json:"token"`
		WsPath    string `json:"wsPath"`
		MachineID string `json:"machineId"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil || out.Token == "" {
		fmt.Fprintf(os.Stderr, "pair: bad response: %s\n", string(respBody))
		return 1
	}

	cfg.Server = *server
	cfg.Token = out.Token
	if *root != "" {
		cfg.WorkspaceRoot = *root
	}
	if *label != "" {
		cfg.Label = *label
	}
	if err := cfg.Save(); err != nil {
		fmt.Fprintf(os.Stderr, "save config failed: %v\n", err)
		return 1
	}

	fmt.Printf("paired with %s (machine %s)\n", *server, cfg.MachineID)
	fmt.Println("token saved to", cfg.Path())
	fmt.Println("next: pi-agent run   (or: systemctl start pi-agent)")
	_ = version
	return 0
}
