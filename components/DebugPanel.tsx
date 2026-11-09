"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface DebugStream {
  sessionId: string;
  openedAt: number;
  connectedAt: number | null;
  lastWriteAt: number | null;
  bytesWritten: number;
}

interface DebugSession {
  sessionId: string | null;
  ownerId: number;
  mode: string;
  cwd: string;
  sessionFile: string | null;
  alive: boolean;
  running: boolean;
  chatOnly: boolean;
  pendingPromptCount: number;
  forceShutdownOnIdle: boolean;
  startedAt: number;
  idleDeadlineAt: number | null;
  lastCommandType: string | null;
  lastCommandAt: number | null;
  streams: number;
}

interface DebugProcess {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  heapLimitBytes: number;
  eventLoopDelayMs: { mean: number; p95: number; max: number } | null;
  perf: {
    restore: {
      queued: number;
      active: number;
      completed: number;
      workerParses: number;
      syncParses: number;
      lruHits: number;
      totalParseMs: number;
      maxParseMs: number;
      lastParseMs: number;
    };
    scan: { lastMs: number; maxMs: number; count: number; lastChangedFiles: number };
  };
}

interface DebugSnapshot {
  now: number;
  uptimeMs: number;
  process?: DebugProcess;
  totals: {
    wrappers: number;
    alive: number;
    running: number;
    streams: number;
    startingCwds: number;
  };
  sessions: DebugSession[];
  startingCwds: Array<{ cwd: string; count: number }>;
  streams: DebugStream[];
  selected: {
    sessionId: string;
    trust: { requiresTrust: boolean; trusted: boolean; reasons: string[] };
    mcpServers: Array<{
      name: string;
      scope: string;
      transport: string;
      directToolsOn: boolean;
      disabled: boolean;
    }>;
  } | null;
}

const POLL_MS = 2_000;

function shortId(value: string | null): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatMs(ms: number | undefined | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return `${ms.toFixed(1)} ms`;
}

export function DebugPanel({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(
          `/api/agent/debug${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as DebugSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
      }
    };

    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setTick((value) => value + 1), 1_000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId]);

  const elapsedSinceSnapshot = useMemo(() => {
    if (!snapshot) return 0;
    return Math.max(0, Date.now() - snapshot.now);
  }, [snapshot, tick]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("debug.title")}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "48px 16px 16px",
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(1040px, 100%)",
          maxHeight: "calc(100vh - 64px)",
          overflow: "auto",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          <strong style={{ fontSize: 13 }}>{t("debug.title")}</strong>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {snapshot ? t("debug.uptime", { value: formatDuration(snapshot.uptimeMs) }) : t("debug.loading")}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--text)",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {t("debug.close")}
          </button>
        </div>

        <div style={{ padding: 14 }}>
          {error && (
            <div style={{ marginBottom: 12, fontSize: 12, color: "var(--danger)" }}>
              {t("debug.loadError", { error })}
            </div>
          )}

          {!snapshot ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("debug.loading")}</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                {[
                  [t("debug.wrappers"), snapshot.totals.wrappers],
                  [t("debug.alive"), snapshot.totals.alive],
                  [t("debug.running"), snapshot.totals.running],
                  [t("debug.streams"), snapshot.totals.streams],
                  [t("debug.starting"), snapshot.totals.startingCwds],
                  [
                    t("debug.heap"),
                    snapshot.process
                      ? `${formatMb(snapshot.process.heapUsedBytes)} / ${formatMb(snapshot.process.heapLimitBytes)}`
                      : "—",
                  ],
                  [t("debug.rss"), snapshot.process ? formatMb(snapshot.process.rssBytes) : "—"],
                  [
                    t("debug.loopDelay"),
                    snapshot.process?.eventLoopDelayMs ? formatMs(snapshot.process.eventLoopDelayMs.p95) : "—",
                  ],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "var(--bg-secondary, transparent)",
                    }}
                  >
                    <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{label}</div>
                    <div style={{ fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                  </div>
                ))}
              </div>

              <h3 style={{ fontSize: 12, margin: "16px 0 6px" }}>{t("debug.sessions")}</h3>
              {snapshot.sessions.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("debug.noSessions")}</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                        {[
                          t("debug.session"),
                          t("debug.owner"),
                          t("debug.mode"),
                          t("debug.state"),
                          t("debug.idle"),
                          t("debug.lastCommand"),
                          t("debug.streams"),
                        ].map((label) => (
                          <th key={label} style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.sessions.map((session) => {
                        const idle =
                          session.idleDeadlineAt === null
                            ? null
                            : session.idleDeadlineAt - (snapshot.now + elapsedSinceSnapshot);
                        return (
                          <tr
                            key={session.sessionId ?? String(session.startedAt)}
                            style={{
                              background:
                                session.sessionId === sessionId ? "var(--bg-selected, rgba(127,127,127,0.12))" : undefined,
                            }}
                          >
                            <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)" }} title={session.cwd}>
                              {shortId(session.sessionId)}
                            </td>
                            <td style={{ padding: "4px 6px" }}>#{session.ownerId}</td>
                            <td style={{ padding: "4px 6px" }}>{session.mode}</td>
                            <td style={{ padding: "4px 6px" }}>
                              {!session.alive
                                ? t("debug.stateClosing")
                                : session.running
                                  ? t("debug.stateRunning")
                                  : t("debug.stateIdle")}
                              {session.pendingPromptCount > 0 ? ` · ${session.pendingPromptCount}` : ""}
                            </td>
                            <td style={{ padding: "4px 6px" }}>{idle === null ? "—" : formatDuration(idle)}</td>
                            <td style={{ padding: "4px 6px" }}>{session.lastCommandType ?? "—"}</td>
                            <td style={{ padding: "4px 6px" }}>{session.streams}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {snapshot.startingCwds.length > 0 && (
                <>
                  <h3 style={{ fontSize: 12, margin: "16px 0 6px" }}>{t("debug.startingCwds")}</h3>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--text-dim)" }}>
                    {snapshot.startingCwds.map((row) => (
                      <li key={row.cwd} style={{ fontFamily: "var(--font-mono)" }}>
                        {row.cwd} × {row.count}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {snapshot.selected && (
                <>
                  <h3 style={{ fontSize: 12, margin: "16px 0 6px" }}>
                    {t("debug.selected")} · {shortId(snapshot.selected.sessionId)}
                  </h3>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>
                    {t("debug.trust", {
                      value: snapshot.selected.trust.trusted
                        ? t("debug.trusted")
                        : t("debug.untrusted"),
                    })}
                    {snapshot.selected.trust.requiresTrust
                      ? ` · ${snapshot.selected.trust.reasons.join(", ") || t("debug.trustReasons")}`
                      : ""}
                  </div>
                  {snapshot.selected.mcpServers.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("debug.noMcp")}</div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                          <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>
                            {t("debug.mcpServer")}
                          </th>
                          <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>
                            {t("debug.mcpScope")}
                          </th>
                          <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>
                            {t("debug.mcpTransport")}
                          </th>
                          <th style={{ padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>
                            {t("debug.mcpState")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.selected.mcpServers.map((server) => (
                          <tr key={`${server.scope}:${server.name}`}>
                            <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)" }}>{server.name}</td>
                            <td style={{ padding: "4px 6px" }}>{server.scope}</td>
                            <td style={{ padding: "4px 6px", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>
                              {server.transport}
                            </td>
                            <td style={{ padding: "4px 6px" }}>
                              {server.disabled ? t("debug.mcpDisabled") : t("debug.mcpEnabled")}
                              {server.directToolsOn ? " · direct" : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
