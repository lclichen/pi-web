"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface ShellOption {
  id: string;
  label: string;
  path: string;
}

interface Props {
  cwd: string;
  /** Whether the terminal tab is active — re-fit when shown again. */
  visible: boolean;
}

/**
 * Interactive terminal running a PTY on the pi-web server host, in the
 * workspace directory. Lifecycle is keyed by cwd (one terminal per workspace:
 * switching sessions within the same cwd keeps the shell, switching cwd
 * destroys it): click the tab → auto-connect; receive `exit` → banner +
 * reconnect button.
 *
 * Mirrors components/relay/Terminal.tsx (the Go-agent terminal) but talks to
 * /api/terminal/* and adds a shell picker, clear and reconnect.
 */
export function WorkspaceTerminal({ cwd, visible }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [shellId, setShellId] = useState<string>("");
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [exited, setExited] = useState<number | null>(null);

  // Shell list for the dropdown (default = first detected entry).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/terminal/shells")
      .then((r) => r.json())
      .then((body: { data?: { shells?: ShellOption[] } }) => {
        if (cancelled || !body.data?.shells?.length) return;
        setShells(body.data.shells);
        setShellId((prev) => prev || body.data!.shells![0].id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Terminal lifecycle: one PTY per (cwd, shell, reconnect) combination.
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !shellId) return;
    setExited(null);

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Menlo, Consolas, \"Courier New\", monospace",
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    termRef.current = term;
    term.loadAddon(fitAddon);
    term.open(el);
    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // zero-size container (hidden tab) — refit when visible again
      }
    };
    const raf = requestAnimationFrame(fit);

    let sessionId: string | null = null;
    let es: EventSource | null = null;
    let dead = false;

    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});

    const inputSub = term.onData((data) => {
      if (sessionId && !dead) void post(`/api/terminal/${sessionId}/input`, { data });
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (sessionId && !dead) void post(`/api/terminal/${sessionId}/resize`, { cols, rows });
    });

    const ro = new ResizeObserver(fit);
    ro.observe(el);

    (async () => {
      try {
        const res = await fetch("/api/terminal/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, cols: term.cols, rows: term.rows, shell: shellId }),
        });
        const body = (await res.json()) as {
          success?: boolean;
          data?: { sessionId?: string };
          error?: string;
        };
        if (!res.ok || !body.success || !body.data?.sessionId) {
          term.writeln(`\x1b[31m无法启动终端：${body.error ?? `HTTP ${res.status}`}\x1b[0m`);
          return;
        }
        sessionId = body.data.sessionId;

        es = new EventSource(`/api/terminal/${sessionId}/events`);
        es.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data) as { type?: string; data?: string; code?: number };
            if (payload.type === "output" && typeof payload.data === "string") {
              term.write(payload.data);
            } else if (payload.type === "exit") {
              dead = true;
              setExited(typeof payload.code === "number" ? payload.code : 0);
              term.write(`\r\n\x1b[90m—— 进程已退出${typeof payload.code === "number" ? `（代码 ${payload.code}）` : ""}，点击右上角「重连」重新启动 ——\x1b[0m\r\n`);
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
      if (sessionId) void post(`/api/terminal/${sessionId}/close`, {});
      term.dispose();
      fitRef.current = null;
      termRef.current = null;
    };
  }, [cwd, shellId, reconnectNonce]);

  // Re-showing the tab (display:none → block) needs an explicit refit.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => fitRef.current?.fit());
  }, [visible]);

  const shellLabel = shells.find((s) => s.id === shellId)?.label ?? shellId;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#000" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
          background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600 }}>终端</span>
        {shells.length > 0 && (
          <select
            value={shellId}
            onChange={(e) => setShellId(e.target.value)}
            title="Shell"
            style={{
              fontSize: 11, padding: "1px 4px", maxWidth: 130,
              background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4,
            }}
          >
            {shells.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        )}
        <span
          title={cwd}
          style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}
        >
          {cwd}
        </span>
        <button
          onClick={() => termRef.current?.clear()}
          title="清屏"
          style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "1px 8px" }}
        >
          清屏
        </button>
        <button
          onClick={() => setReconnectNonce((n) => n + 1)}
          title={exited === null ? "关闭当前 shell 并重新启动" : "重新启动 shell"}
          style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: exited === null ? "var(--text-muted)" : "var(--accent)", cursor: "pointer", fontSize: 11, padding: "1px 8px" }}
        >
          {exited === null ? "重启" : "重连"}
        </button>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, padding: 4, background: "#000" }} data-shell={shellLabel} />
    </div>
  );
}
