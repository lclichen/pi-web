package workspace

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
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
	// WaitDelay (Go 1.20+): the process may exit while a grandchild still
	// holds the stdout/stderr pipe open (e.g. `nohup … &`, daemonized tools).
	// Without it, Wait blocks forever on the copy goroutines and the caller
	// never gets a response. With it, Wait returns shortly after exit.
	cmd.WaitDelay = 1 * time.Second

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

// streamWriter adapts the incremental stdout/stderr emission used by ExecStream
// to exec.Cmd's io.Writer contract. Writes arrive from cmd's internal copy
// goroutines, which Wait tracks and WaitDelay bounds.
type streamWriter struct {
	stream string
	emit   func(stream, text string)
}

func (sw *streamWriter) Write(p []byte) (int, error) {
	sw.emit(sw.stream, string(p))
	return len(p), nil
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
	// Same WaitDelay rationale as Exec: a grandchild holding the pipes open
	// must not stall the terminal end frame forever.
	cmd.WaitDelay = 1 * time.Second
	cmd.Stdout = &streamWriter{stream: "stdout", emit: emit}
	cmd.Stderr = &streamWriter{stream: "stderr", emit: emit}

	err = cmd.Run()
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
