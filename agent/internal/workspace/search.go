package workspace

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// GrepMatch is one hit from search.grep.
type GrepMatch struct {
	File string `json:"file"` // path relative to workspace root
	Line int    `json:"line"`
	Text string `json:"text"`
}

const (
	grepMaxFile   = 1 << 20 // 1 MB: skip files larger than this for content search
	defaultGrep   = 200
	defaultFd     = 500
	binarySniffSize = 1024
)

// skipDirs are heavy/irrelevant dirs excluded from traversal (a coarse
// stand-in for .gitignore: keeps searches out of node_modules/.git/etc).
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, ".next": true, "dist": true,
	".cache": true, "vendor": true, "target": true, "__pycache__": true,
	".svn": true, ".hg": true, ".pi-agent": true,
}

var errStopWalk = fmt.Errorf("__stop_walk")

// Grep searches file contents with a Go-native tree walk + regexp. Deterministic
// across platforms — no dependency on rg/grep/find, which mishandle Windows path
// separators. Skips the dirs in skipDirs, files > grepMaxFile, and binary files.
func (w *Workspace) Grep(params map[string]interface{}) (interface{}, error) {
	pattern := paramString(params, "pattern", "")
	if pattern == "" {
		return nil, fmt.Errorf("pattern required")
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("invalid pattern: %w", err)
	}
	abs, err := w.resolve(paramString(params, "path", "."))
	if err != nil {
		return nil, err
	}
	glob := paramString(params, "glob", "")
	max := paramInt(params, "maxResults", defaultGrep)

	matches := []GrepMatch{}
	walkErr := filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if d.IsDir() {
			if p != abs && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(matches) >= max {
			return errStopWalk
		}
		if glob != "" {
			if ok, _ := filepath.Match(glob, d.Name()); !ok {
				return nil
			}
		}
		for _, hit := range grepFile(p, re) {
			if len(matches) >= max {
				break
			}
			matches = append(matches, GrepMatch{File: w.relToRoot(p), Line: hit.line, Text: hit.text})
		}
		return nil
	})
	if walkErr != nil && walkErr != errStopWalk {
		return nil, walkErr
	}
	return matches, nil
}

type lineHit struct {
	line int
	text string
}

// grepFile returns matching (1-based line, text) pairs. Files larger than
// grepMaxFile or containing a NUL byte in the first chunk are treated as binary
// and skipped.
func grepFile(p string, re *regexp.Regexp) []lineHit {
	info, err := os.Stat(p)
	if err != nil || info.IsDir() || info.Size() > grepMaxFile {
		return nil
	}
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()

	head := make([]byte, binarySniffSize)
	n, _ := f.Read(head)
	if bytes.IndexByte(head[:n], 0) >= 0 {
		return nil // binary
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil
	}

	hits := []lineHit{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	ln := 0
	for sc.Scan() {
		ln++
		if re.MatchString(sc.Text()) {
			hits = append(hits, lineHit{ln, sc.Text()})
		}
	}
	return hits
}

// Fd lists entries by name (Go-native walk). Pattern with glob chars (* ? [)
// is matched as a glob on the basename; otherwise substring match. type "d"
// lists directories, otherwise files.
func (w *Workspace) Fd(params map[string]interface{}) (interface{}, error) {
	pattern := paramString(params, "pattern", "")
	if pattern == "" {
		return nil, fmt.Errorf("pattern required")
	}
	abs, err := w.resolve(paramString(params, "path", "."))
	if err != nil {
		return nil, err
	}
	wantDir := paramString(params, "type", "") == "d"
	max := paramInt(params, "maxResults", defaultFd)

	paths := []string{}
	walkErr := filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if len(paths) >= max {
			return errStopWalk
		}
		if d.IsDir() {
			if p != abs && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			if p != abs && wantDir && matchName(d.Name(), pattern) {
				paths = append(paths, w.relToRoot(p))
			}
			return nil
		}
		if !wantDir && matchName(d.Name(), pattern) {
			paths = append(paths, w.relToRoot(p))
		}
		return nil
	})
	if walkErr != nil && walkErr != errStopWalk {
		return nil, walkErr
	}
	return paths, nil
}

func matchName(name, pattern string) bool {
	if strings.ContainsAny(pattern, "*?[") {
		ok, _ := filepath.Match(pattern, name)
		return ok
	}
	return strings.Contains(name, pattern)
}

func paramInt(params map[string]interface{}, key string, dflt int) int {
	if v, ok := params[key]; ok {
		if n, ok := v.(float64); ok {
			return int(n)
		}
	}
	return dflt
}
