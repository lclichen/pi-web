package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/egoist/mygo"
)

// serverEntry is one saved pairing: ~/.agent-client/config.json (the first
// server) or one of ~/.agent-client/profiles/*.json (additional servers).
type serverEntry struct {
	Path          string
	Server        string
	Label         string
	MachineID     string
	WorkspaceRoot string
	Default       bool
}

// cliConfig mirrors the fields of the agent-client config we need. Unknown
// fields are ignored and never written by the GUI.
type cliConfig struct {
	Server        string `json:"server"`
	Token         string `json:"token"`
	WorkspaceRoot string `json:"workspaceRoot"`
	MachineID     string `json:"machineId"`
	Label         string `json:"label"`
}

func agentClientDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".agent-client"), nil
}

// scanServerConfigs reads the CLI's default config and every per-server
// profile. Entries without server+token (half-paired files) are skipped.
func scanServerConfigs() []serverEntry {
	dir, err := agentClientDir()
	if err != nil {
		return nil
	}
	paths := []string{filepath.Join(dir, "config.json")}
	profiles, _ := filepath.Glob(filepath.Join(dir, "profiles", "*.json"))
	sort.Strings(profiles)
	paths = append(paths, profiles...)

	out := make([]serverEntry, 0, len(paths))
	for i, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var cfg cliConfig
		if json.Unmarshal(data, &cfg) != nil || cfg.Server == "" || cfg.Token == "" {
			continue
		}
		label := strings.TrimSpace(cfg.Label)
		if label == "" {
			label = fallbackMachineLabel(cfg.Server)
		}
		out = append(out, serverEntry{
			Path:          path,
			Server:        cfg.Server,
			Label:         label,
			MachineID:     cfg.MachineID,
			WorkspaceRoot: cfg.WorkspaceRoot,
			Default:       i == 0,
		})
	}
	return out
}

// fallbackMachineLabel names a machine whose config has no label yet.
func fallbackMachineLabel(server string) string {
	if u, err := url.Parse(server); err == nil && u.Host != "" {
		return u.Host
	}
	return "未命名机器"
}

// resolveAgentClient finds the agent-client binary shipped next to the GUI
// (resources/bin/agent-client) or available on the machine, and reports its
// version. A binary without the executable bit (tar produced on Windows) is
// chmod-ed in place, or copied into the user's data directory when the
// install is read-only.
func resolveAgentClient() (path, version string, err error) {
	candidates := make([]string, 0, 8)
	if v := strings.TrimSpace(os.Getenv("PI_AGENT_CLIENT")); v != "" {
		candidates = append(candidates, v)
	}
	if resources, perr := mygo.App.Path(mygo.PathResources); perr == nil {
		candidates = append(candidates,
			filepath.Join(resources, "bin", agentClientName()),
			filepath.Join(resources, agentClientName()),
		)
	}
	if exe, eerr := os.Executable(); eerr == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "bin", agentClientName()),
			filepath.Join(dir, agentClientName()),
		)
	}
	// Development: the repo keeps cross-built binaries in agent/dist.
	if cwd, cerr := os.Getwd(); cerr == nil {
		for _, up := range []string{"..", filepath.Join("..", "..")} {
			candidates = append(candidates,
				filepath.Join(cwd, up, "dist", "agent-client-"+runtime.GOOS+"-"+runtime.GOARCH+agentClientSuffix()),
			)
		}
	}
	for _, candidate := range candidates {
		if st, serr := os.Stat(candidate); serr == nil && !st.IsDir() {
			path, cerr := ensureExecutable(candidate)
			if cerr != nil {
				continue
			}
			return path, agentClientVersion(path), nil
		}
	}
	if path, lerr := exec.LookPath("agent-client"); lerr == nil {
		return path, agentClientVersion(path), nil
	}
	return "", "", fmt.Errorf("未找到 agent-client：请与本客户端一起分发，或安装到 PATH")
}

func agentClientName() string {
	if runtime.GOOS == "windows" {
		return "agent-client.exe"
	}
	return "agent-client"
}

func agentClientSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

// agentClientVersion runs `agent-client version` and returns "0.4.2".
func agentClientVersion(bin string) string {
	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) >= 2 {
		return fields[len(fields)-1]
	}
	return strings.TrimSpace(string(out))
}

// ensureExecutable returns a path that can be executed: chmod in place when
// possible, otherwise a private copy under the user's data directory.
func ensureExecutable(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" || st.Mode()&0o111 != 0 {
		return path, nil
	}
	if os.Chmod(path, st.Mode()|0o111) == nil {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dstDir := filepath.Join(home, ".local", "share", "agent-client-gui", "bin")
	if err := os.MkdirAll(dstDir, 0o700); err != nil {
		return "", err
	}
	dst := filepath.Join(dstDir, filepath.Base(path))
	if err := copyExecutable(path, dst); err != nil {
		return "", err
	}
	return dst, nil
}

func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}
