package workspace

import (
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"piagent/internal/protocol"
)

const maxReadSize = 10 * 1024 * 1024 // 10 MB

// List lists a directory (dirs first, then alphabetical).
func (w *Workspace) List(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", ".")
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return entries[i].Name() < entries[j].Name()
	})
	base := w.relToRoot(abs)
	out := make([]protocol.FsEntry, 0, len(entries))
	for _, e := range entries {
		var size, mtime int64
		if info, err := e.Info(); err == nil {
			size = info.Size()
			mtime = info.ModTime().UnixMilli()
		}
		out = append(out, protocol.FsEntry{
			Name:  e.Name(),
			Path:  filepath.ToSlash(filepath.Join(base, e.Name())),
			IsDir: e.IsDir(),
			Size:  size,
			Mtime: mtime,
		})
	}
	return out, nil
}

// maxManifestEntries bounds one fs.manifest response. Truncated results are not
// authoritative: the caller falls back to per-file stats instead of treating
// missing paths as deleted.
const maxManifestEntries = 10000

// Manifest returns a stat-only listing for several roots in one round trip.
// Paths are relative to this workspace (request `base`), slash-separated.
// Symlinks (including symlinked roots), .git and node_modules/.cache are
// skipped: projection only copies regular files and those trees are noise.
func (w *Workspace) Manifest(params map[string]interface{}) (interface{}, error) {
	roots := paramStrings(params, "roots")
	if len(roots) == 0 {
		return nil, fmt.Errorf("roots required")
	}
	realRoot := w.realRoot(w.GetRoot())
	entries := make([]protocol.ManifestEntry, 0)
	truncated := false

	for _, raw := range roots {
		if raw == "" {
			continue
		}
		target := raw
		if !filepath.IsAbs(target) {
			target = filepath.Join(w.GetRoot(), target)
		}
		li, lerr := os.Lstat(target)
		if lerr == nil && li.Mode()&os.ModeSymlink != 0 {
			continue
		}
		abs, err := w.resolve(target)
		if err != nil {
			return nil, err
		}
		if lerr != nil {
			if os.IsNotExist(lerr) {
				continue
			}
			return nil, lerr
		}
		if !li.IsDir() {
			if li.Mode().IsRegular() {
				if len(entries) >= maxManifestEntries {
					truncated = true
					break
				}
				rel, err := filepath.Rel(realRoot, abs)
				if err != nil {
					return nil, err
				}
				entries = append(entries, protocol.ManifestEntry{
					Path:  filepath.ToSlash(rel),
					Size:  li.Size(),
					Mtime: li.ModTime().UnixMilli(),
				})
			}
			continue
		}
		err = filepath.WalkDir(abs, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				// A child we cannot read makes the listing incomplete.
				truncated = true
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				if d.Name() == ".git" {
					return filepath.SkipDir
				}
				if d.Name() == ".cache" && filepath.Base(filepath.Dir(path)) == "node_modules" {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				truncated = true
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			if len(entries) >= maxManifestEntries {
				truncated = true
				return filepath.SkipAll
			}
			rel, err := filepath.Rel(realRoot, path)
			if err != nil {
				return nil
			}
			entries = append(entries, protocol.ManifestEntry{
				Path:  filepath.ToSlash(rel),
				Size:  info.Size(),
				Mtime: info.ModTime().UnixMilli(),
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
		if truncated {
			break
		}
	}
	return protocol.ManifestResult{Entries: entries, Truncated: truncated}, nil
}

// Read reads a file's contents (capped at maxReadSize).
func (w *Workspace) Read(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", "")
	if p == "" {
		return nil, fmt.Errorf("path required")
	}
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxReadSize {
		return nil, fmt.Errorf("file too large (%d bytes; max %d)", info.Size(), maxReadSize)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	// Binary-safe reads: JSON strings cannot carry arbitrary bytes (Go replaces
	// invalid UTF-8), so image/audio/video previews ask for base64 instead.
	if paramString(params, "encoding", "") == "base64" {
		return map[string]interface{}{
			"path":          w.relToRoot(abs),
			"contentBase64": base64.StdEncoding.EncodeToString(data),
			"encoding":      "base64",
			"size":          info.Size(),
			"mtime":         info.ModTime().UnixMilli(),
		}, nil
	}
	return map[string]interface{}{
		"path":    w.relToRoot(abs),
		"content": string(data),
		"size":    info.Size(),
		"mtime":   info.ModTime().UnixMilli(),
	}, nil
}

// Write creates/truncates a file (creating parent dirs). Binary payloads use
// contentBase64 (advertised as the "binary-write" feature): the UTF-8 content
// string cannot carry arbitrary bytes, so images/PDFs uploaded from the WebUI
// would be corrupted.
func (w *Workspace) Write(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", "")
	if p == "" {
		return nil, fmt.Errorf("path required")
	}
	var data []byte
	if encoded := paramString(params, "contentBase64", ""); encoded != "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("contentBase64: %w", err)
		}
		data = decoded
	} else {
		data = []byte(paramString(params, "content", ""))
	}
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return nil, err
	}
	var size int64
	if info, err := os.Stat(abs); err == nil {
		size = info.Size()
	}
	return map[string]interface{}{"ok": true, "size": size}, nil
}

// Stat reports metadata for a path (exists=false when missing).
func (w *Workspace) Stat(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", "")
	if p == "" {
		return nil, fmt.Errorf("path required")
	}
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{"path": w.relToRoot(abs), "exists": false}, nil
		}
		return nil, err
	}
	return map[string]interface{}{
		"path":   w.relToRoot(abs),
		"exists": true,
		"isDir":  info.IsDir(),
		"size":   info.Size(),
		"mtime":  info.ModTime().UnixMilli(),
	}, nil
}

// Mkdir creates a directory (and parents).
func (w *Workspace) Mkdir(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", "")
	if p == "" {
		return nil, fmt.Errorf("path required")
	}
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	return map[string]interface{}{"ok": true}, nil
}

// Delete removes a file or directory tree. Refuses the workspace root.
func (w *Workspace) Delete(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", "")
	if p == "" {
		return nil, fmt.Errorf("path required")
	}
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	if abs == w.realRoot(w.GetRoot()) {
		return nil, fmt.Errorf("refuse to delete workspace root")
	}
	if err := os.RemoveAll(abs); err != nil {
		return nil, err
	}
	return map[string]interface{}{"ok": true}, nil
}

// Rename moves a file/directory. Both endpoints must stay within the root.
func (w *Workspace) Rename(params map[string]interface{}) (interface{}, error) {
	from := paramString(params, "from", "")
	to := paramString(params, "to", "")
	if from == "" || to == "" {
		return nil, fmt.Errorf("from and to required")
	}
	absFrom, err := w.resolve(from)
	if err != nil {
		return nil, err
	}
	absTo, err := w.resolve(to)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absTo), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(absFrom, absTo); err != nil {
		return nil, err
	}
	return map[string]interface{}{"ok": true, "path": w.relToRoot(absTo)}, nil
}

// paramStrings reads a JSON array of strings (also accepts []string in tests).
func paramStrings(params map[string]interface{}, key string) []string {
	v, ok := params[key]
	if !ok {
		return nil
	}
	switch list := v.(type) {
	case []string:
		return list
	case []interface{}:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
