"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentCall } from "@/hooks/useAgentSession";
import { encodeFilePathForApi } from "@/lib/file-paths";

interface Props {
  cwd?: string;
  subagentCalls: SubagentCall[];
  onOpenAgents: () => void;
  onOpenPlan: () => void;
  onToggleTerminal?: () => void;
  /** Plan tab is active — highlight the plan row. */
  planActive?: boolean;
  /** Bottom terminal drawer is open — highlight the terminal row. */
  terminalActive?: boolean;
  /** Remote session (sandbox / local machine): plan file is read through
   *  /api/remotefs from the container workspace, not the server home. */
  remote?: { sessionId: string; label: string } | null;
}

/**
 * Floating status capsule at the top-right of the conversation. Collapsed it
 * shows one pill (plan summary / agent pulse + chevron); clicking expands a
 * popover with the individual rows: 计划 / 智能体 / 终端（底部抽屉） / 进程
 * (disabled placeholder). The plan file (`.pi/plan.md` → `PLAN.md`) is
 * live-refreshed — SSE watch locally, 10s polling for remote sessions.
 */
export function ChatStatusWidget({
  cwd, subagentCalls, onOpenAgents, onOpenPlan, onToggleTerminal, planActive, terminalActive, remote = null,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ path: string; summary: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const runningCount = useMemo(
    () => subagentCalls.filter((c) => c.status === "running" || c.status === "background").length,
    [subagentCalls],
  );

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Plan file: try .pi/plan.md then PLAN.md; keep it fresh (SSE locally,
  // polling for remote — remotefs has no watch endpoint).
  useEffect(() => {
    if (!cwd && !remote) { setPlan(null); return; }
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const root = (cwd ?? "").replace(/[\\/]+$/, "");
    const candidates = [`${root}/.pi/plan.md`, `${root}/PLAN.md`];
    const src = remote ? `?src=${encodeURIComponent(remote.sessionId)}` : "";
    const readUrl = (path: string): string =>
      remote
        ? `/api/remotefs/${encodeFilePathForApi(path.replace(/^\//, ""))}${src}&type=read`
        : `/api/files/${encodeFilePathForApi(path)}?type=read`;

    const apply = (path: string, content: string) => setPlan({ path, summary: planSummary(content, t("计划")) });

    const readCandidate = async (index: number): Promise<void> => {
      if (cancelled || index >= candidates.length) {
        if (!cancelled) setPlan(null);
        return;
      }
      const path = candidates[index];
      try {
        const res = await fetch(readUrl(path));
        if (!res.ok) { await readCandidate(index + 1); return; }
        const d = (await res.json()) as { content?: string };
        if (cancelled) return;
        if (typeof d.content !== "string") { await readCandidate(index + 1); return; }
        apply(path, d.content);
        const refresh = async () => {
          try {
            const r = await fetch(readUrl(path));
            if (!r.ok) return;
            const next = (await r.json()) as { content?: string };
            if (!cancelled && typeof next.content === "string") apply(path, next.content);
          } catch { /* keep the old summary */ }
        };
        if (remote) pollTimer = setInterval(() => void refresh(), 10000);
        else {
          es = new EventSource(`/api/files/${encodeFilePathForApi(path)}?type=watch`);
          es.addEventListener("change", () => void refresh());
        }
      } catch {
        await readCandidate(index + 1);
      }
    };
    void readCandidate(0);

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [cwd, remote]);

  const anyActive = planActive || terminalActive;

  return (
    <div
      ref={rootRef}
      className="chat-status-widget"
      style={{ position: "absolute", top: 12, right: 36, zIndex: 45, pointerEvents: "auto" }}
    >
      {/* The single capsule */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("会话状态：计划 / 智能体 / 终端")}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          maxWidth: 320, overflow: "hidden",
          padding: "3px 10px", borderRadius: 999,
          fontSize: 11, cursor: "pointer",
          background: open || anyActive ? "var(--bg-selected)" : "var(--bg-panel)",
          color: "var(--text)",
          border: `1px solid ${open || anyActive ? "var(--accent)" : "var(--border)"}`,
        }}
      >
        {runningCount > 0 ? (
          <span className="chat-status-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        )}
        {plan ? (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plan.summary}</span>
        ) : (
          <span>{t("状态")}</span>
        )}
        {runningCount > 0 && <span style={{ color: "var(--accent)", fontWeight: 700, flexShrink: 0 }}>{runningCount}</span>}
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
        >
          <polyline points="2 4 5 7 8 4" />
        </svg>
      </button>

      {/* Expanded rows */}
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            minWidth: 200, maxWidth: 300,
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.12)", overflow: "hidden", padding: 3,
          }}
        >
          {plan ? (
            <Row
              onClick={() => { onOpenPlan(); setOpen(false); }}
              title={plan.path}
              active={planActive}
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" /></svg>}
              label={plan.summary}
            />
          ) : null}
          <Row
            onClick={() => { onOpenAgents(); setOpen(false); }}
            title={t("子智能体目录")}
            active={false}
            icon={runningCount > 0
              ? <span className="chat-status-pulse" style={{ width: 8, height: 8, borderRadius: 999, background: "var(--accent)" }} />
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4" /><circle cx="9" cy="14" r="0.6" /><circle cx="15" cy="14" r="0.6" /></svg>}
            label={t("智能体")}
            trailing={runningCount > 0 ? <span style={{ color: "var(--accent)", fontWeight: 700 }}>{t("{n} 运行中", { n: runningCount })}</span> : undefined}
          />
          {onToggleTerminal && (
            <Row
              onClick={() => { onToggleTerminal(); setOpen(false); }}
              title={t("底部终端（工作区 shell）")}
              active={terminalActive}
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>}
              label={t("终端")}
              trailing={terminalActive ? <span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("已打开")}</span> : undefined}
            />
          )}
          <Row
            disabled
            title={t("等待 TODO 工具接入")}
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7" /></svg>}
            label={t("进程")}
            trailing={<span style={{ fontSize: 10 }}>{t("待接入")}</span>}
          />
        </div>
      )}
    </div>
  );
}

function Row({ onClick, title, icon, label, trailing, active, disabled }: {
  onClick?: () => void;
  title?: string;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        width: "100%", padding: "6px 9px", border: "none", borderRadius: 7,
        background: active ? "var(--bg-selected)" : "transparent",
        color: disabled ? "var(--text-dim)" : "var(--text)",
        fontSize: 11, textAlign: "left", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!disabled && !active) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ display: "flex", flexShrink: 0, color: active ? "var(--accent)" : "inherit" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {trailing && <span style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: 10 }}>{trailing}</span>}
    </button>
  );
}

/** First meaningful line of the plan file, trimmed for the chip. */
function planSummary(content: string, fallback: string): string {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("---")) continue;
    return line.length > 60 ? line.slice(0, 60) + "…" : line;
  }
  const firstHeading = content.split("\n").find((l) => l.trim().startsWith("#"));
  if (firstHeading) {
    const text = firstHeading.replace(/^#+\s*/, "").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }
  return fallback;
}
