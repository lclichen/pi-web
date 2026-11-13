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

// serverEntry is one saved pairing. agent-client >= 0.5 keeps every server in
// ONE file (~/.agent-client/config.json) as a map; older versions spread them
// over that file plus profiles/*.json and the pre-0.3 ~/.pi-agent/config.json.
// All are listed here; Path tells the CLI which file holds the credentials.
type serverEntry struct {
	Path          string
	Server        string
	Label         string
	MachineID     string
	WorkspaceRoot string
	Default       bool
}

// key identifies a connection in GUI state. Two config files may spell the
// same relay differently (trailing slash, case), so the normalized URL — not
// the file path — is the identity.
func (s serverEntry) key() string {
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(s.Server), "/"))
}

// cliConfig mirrors the fields of one agent-client connection entry. Unknown
// fields are ignored and never written by the GUI.
type cliConfig struct {
	Server        string `json:"server"`
	Token         string `json:"token"`
	WorkspaceRoot string `json:"workspaceRoot"`
	MachineID     string `json:"machineId"`
	Label         string `json:"label"`
}

// cliStore is the v2 single-file shape (servers keyed by relay URL).
type cliStore struct {
	Version int                  `json:"version"`
	Current string               `json:"current"`
	Servers map[string]cliConfig `json:"servers"`
}

func agentClientDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".agent-client"), nil
}

// legacyAgentClientDir is where agent-client <= 0.2 wrote its single config
// (~/.pi-agent/config.json); newer CLIs still read and update it in place.
func legacyAgentClientDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pi-agent"), nil
}

// scanServerConfigs reads the CLI's single v2 store, every legacy per-server
// profile and the pre-0.3 config. Entries without server+token (half-paired
// files) are skipped; the same relay found in several files is listed once.
func scanServerConfigs() []serverEntry {
	paths := make([]string, 0, 4)
	if dir, err := agentClientDir(); err == nil {
		paths = append(paths, filepath.Join(dir, "config.json"))
		profiles, _ := filepath.Glob(filepath.Join(dir, "profiles", "*.json"))
		sort.Strings(profiles)
		paths = append(paths, profiles...)
	}
	if dir, err := legacyAgentClientDir(); err == nil {
		paths = append(paths, filepath.Join(dir, "config.json"))
	}

	out := make([]serverEntry, 0, len(paths))
	seenPath := make(map[string]bool, len(paths))
	seenServer := make(map[string]bool, len(paths))
	defaultConfig := ""
	if dir, err := agentClientDir(); err == nil {
		defaultConfig = configPathKey(filepath.Join(dir, "config.json"))
	}
	for _, path := range paths {
		key := configPathKey(path)
		if seenPath[key] {
			continue
		}
		seenPath[key] = true
		for _, entry := range readServerEntries(path, key == defaultConfig) {
			serverKey := entry.key()
			if seenServer[serverKey] {
				continue // an earlier (v2/default) source wins
			}
			seenServer[serverKey] = true
			out = append(out, entry)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Default != out[j].Default {
			return out[i].Default
		}
		return out[i].Server < out[j].Server
	})
	return out
}

func configPathKey(path string) string {
	clean := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(clean)
	}
	return clean
}

// readServerEntries loads one config file (v2 map or legacy single object).
// defaultFile marks the legacy single-object layout as the default entry; in
// v2 the server matching "current" is flagged instead.
func readServerEntries(path string, defaultFile bool) []serverEntry {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var store cliStore
	if json.Unmarshal(data, &store) == nil && store.Servers != nil {
		out := make([]serverEntry, 0, len(store.Servers))
		for key, cfg := range store.Servers {
			if cfg.Server == "" {
				cfg.Server = key
			}
			if entry, ok := entryFromConfig(path, cfg); ok {
				entry.Default = sameServerAddress(cfg.Server, store.Current)
				out = append(out, entry)
			}
		}
		return out
	}
	var cfg cliConfig
	if json.Unmarshal(data, &cfg) != nil {
		return nil
	}
	entry, ok := entryFromConfig(path, cfg)
	if !ok {
		return nil
	}
	entry.Default = defaultFile
	return []serverEntry{entry}
}

func entryFromConfig(path string, cfg cliConfig) (serverEntry, bool) {
	if cfg.Server == "" || cfg.Token == "" {
		return serverEntry{}, false
	}
	label := strings.TrimSpace(cfg.Label)
	if label == "" {
		label = fallbackMachineLabel(cfg.Server)
	}
	return serverEntry{
		Path:          path,
		Server:        cfg.Server,
		Label:         label,
		MachineID:     cfg.MachineID,
		WorkspaceRoot: cfg.WorkspaceRoot,
	}, true
}

// configDirLabel shows where the GUI looks for pairings. The legacy directory
// is only mentioned when it holds a config (older agent-client versions).
func configDirLabel() string {
	dir, err := agentClientDir()
	if err != nil {
		return "用户目录不可用"
	}
	if legacy, lerr := legacyAgentClientDir(); lerr == nil {
		if _, serr := os.Stat(filepath.Join(legacy, "config.json")); serr == nil {
			return dir + "  /  " + legacy
		}
	}
	return dir
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
