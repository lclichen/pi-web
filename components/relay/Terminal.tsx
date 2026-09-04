"use client";

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  cwd: string;
  onClose: () => void;
  /** Target machine (multi-machine); omit = the user's default machine. */
  machineId?: string;
}

// Interactive web terminal backed by the agent's PTY (creack/pty on Linux).
// Lifecycle: POST /terminal/create -> attach xterm; SSE for output; POST input
// on keystrokes; POST resize on container resize; POST close on unmount.
// Input/resize/events address the created sid — the server remembers which
// machine hosts it — so only `create` carries the machine selection.
//
// PTY is Linux/macOS only — on a Windows agent, create returns an error which
// is written into the terminal surface.
export function Terminal({ cwd, onClose, machineId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Consolas, \"Courier New\", monospace",
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    const raf = requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });

    let sessionId: string | null = null;
    let es: EventSource | null = null;

    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});

    const inputSub = term.onData((data) => {
      if (sessionId) void post(`/api/agent-relay/terminal/${sessionId}/input`, { data });
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (sessionId) void post(`/api/agent-relay/terminal/${sessionId}/resize`, { cols, rows });
    });

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(el);

    // Create the PTY, then subscribe to its output stream.
    (async () => {
      try {
        const res = await fetch("/api/agent-relay/terminal/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, cols: term.cols, rows: term.rows, ...(machineId ? { machineId } : {}) }),
        });
        const body = (await res.json()) as {
          success?: boolean;
          data?: { sessionId?: string };
          error?: string;
        };
        if (!res.ok || !body.success || !body.data?.sessionId) {
          term.writeln(`\x1b[31m无法启动终端：${body.error ?? `HTTP ${res.status}`}\x1b[0m`);
          if (body.error?.includes("not supported on this build")) {
            term.writeln("PTY 仅在 Linux/macOS Agent 上可用。请在 CentOS 7 等目标机上运行 Agent。");
          }
          return;
        }
        sessionId = body.data.sessionId;

        es = new EventSource(`/api/agent-relay/terminal/${sessionId}/events`);
        es.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data) as { type?: string; data?: string };
            if (payload.type === "output" && typeof payload.data === "string") {
              term.write(payload.data);
            }
          } catch {
            // ignore malformed frames (heartbeats are comment lines)
          }
        };
      } catch (err) {
        term.writeln(`\x1b[31m终端错误：${err instanceof Error ? err.message : String(err)}\x1b[0m`);
      }
    })();

    return () => {
      cancelAnimationFrame(raf);
      inputSub.dispose();
      resizeSub.dispose();
      ro.disconnect();
      es?.close();
      if (sessionId) void post(`/api/agent-relay/terminal/${sessionId}/close`, {});
      term.dispose();
    };
  }, [cwd]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1150, display: "flex",
        alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(900px, 92vw)", height: "min(70vh, 640px)",
          background: "#000", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 12px 36px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", padding: "4px 10px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>终端</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8, fontFamily: "var(--font-mono)" }}>{cwd}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, padding: 4, background: "#000" }} />
      </div>
    </div>
  );
}
