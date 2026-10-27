// Package workspace scopes all file/command operations to a single root
// directory and rejects any path that escapes it (including via ".." or
// symlinks). This is the agent's primary security boundary: mirrors the
// allowed-roots logic in pi-web/lib/file-access.ts.
package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Workspace is a rooted view of the filesystem. Root can be hot-swapped
// (workspace.set-root RPC) while request goroutines resolve paths, so every
// access goes through the RWMutex.
type Workspace struct {
	mu   sync.RWMutex
	Root string
}

// SetRoot hot-swaps the workspace root (validated by the caller).
func (w *Workspace) SetRoot(root string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.Root = root
}

// GetRoot returns the current root (snapshot value; fine for display).
func (w *Workspace) GetRoot() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.Root
}

// For returns the rooted view a request should operate in. A request may name
// an absolute `base` directory (project workspace on the user's machine);
// every relative path in that request resolves against it and ".."/symlinks
// are still fenced inside it. Without `base` the agent-wide Root applies.
//
// This is what lets several local-machine projects share one relay
// connection while each session works in its own folder. It does not widen
// the trust boundary beyond `workspace.set-root`, which can already point the
// agent at any directory on the machine.
func (w *Workspace) For(params map[string]interface{}) (*Workspace, error) {
	base := paramString(params, "base", "")
	if base == "" {
		return w, nil
	}
	if !filepath.IsAbs(base) {
		return nil, fmt.Errorf("base must be an absolute path: %s", base)
	}
	abs, err := filepath.Abs(filepath.Clean(base))
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("base directory does not exist: %s", base)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("base is not a directory: %s", base)
	}
	return &Workspace{Root: abs}, nil
}

// resolve enforces that p (absolute or relative to Root) is inside Root after
// cleaning and symlink resolution, and returns the absolute, real path.
func (w *Workspace) resolve(p string) (string, error) {
	abs, err := w.resolveLoose(p)
	if err != nil {
		return "", err
	}
	root := w.GetRoot()
	if !isWithin(abs, w.realRoot(root)) {
		return "", fmt.Errorf("path outside workspace root: %s", p)
	}
	return abs, nil
}

// resolveLoose resolves p (relative against Root, absolute verbatim) WITHOUT
// the root fence. Read-only operations use it: absolute paths outside the
// root — typically ~/.pi/agent/skills/** asked for by the model — must stay
// readable (bash can `cat` them anyway, so fencing only reads adds friction
// without a security boundary; writes stay fenced via resolve).
func (w *Workspace) resolveLoose(p string) (string, error) {
	root := w.GetRoot()
	if p == "" {
		p = "."
	}
	var target string
	if filepath.IsAbs(p) {
		target = p
	} else {
		target = filepath.Join(root, p)
	}
	abs, err := filepath.Abs(filepath.Clean(target))
	if err != nil {
		return "", err
	}
	return resolveReal(abs), nil
}

// resolveReal resolves symlinks on the longest EXISTING ancestor of abs and
// re-joins the non-existent tail. Evaluating only the full path (the old
// behavior) silently skipped the check when the final segment was a NEW file
// — an intermediate symlink like root/link -> /etc then allowed
// fs.write("link/cron.d/x") to land outside the root.
func resolveReal(abs string) string {
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	dir := filepath.Dir(abs)
	if dir == abs || dir == string(filepath.Separator) || dir == "." {
		return abs
	}
	return filepath.Join(resolveReal(dir), filepath.Base(abs))
}

// realRoot returns the given root with symlinks resolved.
func (w *Workspace) realRoot(root string) string {
	if r, err := filepath.EvalSymlinks(root); err == nil {
		return r
	}
	return root
}

// Resolve is the exported path-safety check: enforces p is inside Root (after
// symlink resolution) and returns the absolute real path. Used by callers
// outside the workspace package (e.g. the pty handler resolving a cwd).
func (w *Workspace) Resolve(p string) (string, error) {
	return w.resolve(p)
}

// relToRoot returns a clean slash path relative to Root, for response payloads.
func (w *Workspace) relToRoot(abs string) string {
	root := w.realRoot(w.GetRoot())
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(rel)
}

// isWithin reports whether path is root or a descendant of root.
func isWithin(p, root string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == ".." {
		return false
	}
	if strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return !filepath.IsAbs(rel)
}

// paramString reads a string param with a default.
func paramString(params map[string]interface{}, key, dflt string) string {
	if v, ok := params[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return dflt
}
