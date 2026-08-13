package workspace

import (
	"fmt"
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
	return map[string]interface{}{
		"path":    w.relToRoot(abs),
		"content": string(data),
		"size":    info.Size(),
		"mtime":   info.ModTime().UnixMilli(),
	}, nil
}

// Write creates/truncates a file (creating parent dirs).
func (w *Workspace) Write(params map[string]interface{}) (interface{}, error) {
	p := paramString(params, "path", "")
	if p == "" {
		return nil, fmt.Errorf("path required")
	}
	content := paramString(params, "content", "")
	abs, err := w.resolve(p)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
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
	if abs == w.realRoot() {
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
