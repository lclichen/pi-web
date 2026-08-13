package workspace

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

const (
	defaultExecTimeout = 30 * time.Second
	maxExecTimeout     = 120 * time.Second
	maxExecOutput      = 1024 * 1024 // 1 MB per stream
)

// Exec runs argv[0] argv[1:] in cwd with a timeout. Never uses a shell, so
// there is no shell-injection surface: callers must pass an already-split argv.
func (w *Workspace) Exec(params map[string]interface{}) (interface{}, error) {
	argv, err := parseArgv(params)
	if err != nil {
		return nil, err
	}

	cwd := paramString(params, "cwd", ".")
	absCwd, err := w.resolve(cwd)
	if err != nil {
		return nil, err
	}

	timeout := defaultExecTimeout
	if v, ok := toFloat(params["timeout"]); ok {
		d := time.Duration(v) * time.Second
		if d > 0 && d < maxExecTimeout {
			timeout = d
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = absCwd

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			return map[string]interface{}{
				"exitCode": -1,
				"stdout":   truncate(stdout.String()),
				"stderr":   truncate(stderr.String() + "\n[timeout]"),
			}, nil
		} else {
			// spawn-level failure (e.g. command not found)
			return map[string]interface{}{
				"exitCode": -1,
				"stdout":   truncate(stdout.String()),
				"stderr":   truncate(stderr.String() + runErr.Error()),
			}, nil
		}
	}
	return map[string]interface{}{
		"exitCode": exitCode,
		"stdout":   truncate(stdout.String()),
		"stderr":   truncate(stderr.String()),
	}, nil
}

func parseArgv(params map[string]interface{}) ([]string, error) {
	raw, ok := params["argv"]
	if !ok {
		return nil, fmt.Errorf("argv required")
	}
	arr, ok := raw.([]interface{})
	if !ok || len(arr) == 0 {
		return nil, fmt.Errorf("argv must be a non-empty array")
	}
	argv := make([]string, 0, len(arr))
	for _, a := range arr {
		s, ok := a.(string)
		if !ok {
			return nil, fmt.Errorf("argv entries must be strings")
		}
		argv = append(argv, s)
	}
	return argv, nil
}

func toFloat(v interface{}) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

func truncate(s string) string {
	if len(s) > maxExecOutput {
		return s[:maxExecOutput] + "\n...[truncated]"
	}
	return s
}

// ExecStream runs argv like Exec but emits stdout/stderr incrementally via the
// emit callback (stream = "stdout" | "stderr") as they arrive, then returns the
// exit code. The caller (agent) wraps each emit as a streamed chunk frame and
// the final exitCode as a terminal end frame over the WebSocket.
func (w *Workspace) ExecStream(params map[string]interface{}, emit func(stream, text string)) (int, error) {
	argv, err := parseArgv(params)
	if err != nil {
		return -1, err
	}
	cwd := paramString(params, "cwd", ".")
	absCwd, err := w.resolve(cwd)
	if err != nil {
		return -1, err
	}

	timeout := defaultExecTimeout
	if v, ok := toFloat(params["timeout"]); ok {
		d := time.Duration(v) * time.Second
		if d > 0 && d < maxExecTimeout {
			timeout = d
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = absCwd

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return -1, err
	}
	if err := cmd.Start(); err != nil {
		return -1, err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); pipeStream(stdout, "stdout", emit) }()
	go func() { defer wg.Done(); pipeStream(stderr, "stderr", emit) }()
	wg.Wait()

	err = cmd.Wait()
	exitCode := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			emit("stderr", "\n[timeout]")
			return -1, nil
		} else {
			return -1, err
		}
	}
	return exitCode, nil
}

// pipeStream copies r to emit in up-to-4KB chunks until EOF.
func pipeStream(r io.Reader, stream string, emit func(stream, text string)) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			emit(stream, string(buf[:n]))
		}
		if err != nil {
			return
		}
	}
}
