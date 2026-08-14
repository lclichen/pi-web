// Package workspace scopes all file/command operations to a single root
// directory and rejects any path that escapes it (including via ".." or
// symlinks). This is the agent's primary security boundary: mirrors the
// allowed-roots logic in pi-web/lib/file-access.ts.
package workspace

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Workspace is a rooted view of the filesystem.
type Workspace struct {
	Root string
}

// resolve enforces that p (absolute or relative to Root) is inside Root after
// cleaning and symlink resolution, and returns the absolute, real path.
func (w *Workspace) resolve(p string) (string, error) {
	if p == "" {
		p = "."
	}
	var target string
	if filepath.IsAbs(p) {
		target = p
	} else {
		target = filepath.Join(w.Root, p)
	}
	abs, err := filepath.Abs(filepath.Clean(target))
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	realRoot := w.realRoot()
	if !isWithin(abs, realRoot) {
		return "", fmt.Errorf("path outside workspace root: %s", p)
	}
	return abs, nil
}

// realRoot returns Root with symlinks resolved.
func (w *Workspace) realRoot() string {
	if r, err := filepath.EvalSymlinks(w.Root); err == nil {
		return r
	}
	return w.Root
}

// Resolve is the exported path-safety check: enforces p is inside Root (after
// symlink resolution) and returns the absolute real path. Used by callers
// outside the workspace package (e.g. the pty handler resolving a cwd).
func (w *Workspace) Resolve(p string) (string, error) {
	return w.resolve(p)
}

// relToRoot returns a clean slash path relative to Root, for response payloads.
func (w *Workspace) relToRoot(abs string) string {
	rel, err := filepath.Rel(w.realRoot(), abs)
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
