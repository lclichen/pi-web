"use client";

import { useEffect, useMemo, useState } from "react";
import type { SubagentCall } from "@/hooks/useAgentSession";
import { encodeFilePathForApi } from "@/lib/file-paths";

interface Props {
  cwd?: string;
  subagentCalls: SubagentCall[];
  onOpenAgents: () => void;
  onOpenPlan: () => void;
  /** Plan tab is active — highlight the plan chip. */
  planActive?: boolean;
}

/**
 * Floating status bar at the top-right of the conversation (ZCode-style):
 * 计划 / 进程 / 终端 / 智能体 chips. Plan reads the workspace plan file
 * (`.pi/plan.md`, falling back to `PLAN.md`) through the existing files API
 * and live-refreshes via its SSE watch. 进程/终端 await their agent-side
 * tools and render as disabled placeholders. 智能体 shows the live count of
 * running subagents and opens the subagent directory panel.
 */
export function ChatStatusWidget({ cwd, subagentCalls, onOpenAgents, onOpenPlan, planActive }: Props) {
  const [plan, setPlan] = useState<{ path: string; summary: string } | null>(null);

  const runningCount = useMemo(
    () => subagentCalls.filter((c) => c.status === "running" || c.status === "background").length,
    [subagentCalls],
  );

  // Plan file: try .pi/plan.md then PLAN.md; watch whichever exists.
  useEffect(() => {
    if (!cwd) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    let es: EventSource | null = null;
    const root = cwd.replace(/[\\/]+$/, "");
    const candidates = [`${root}/.pi/plan.md`, `${root}/PLAN.md`];

    const readCandidate = async (index: number): Promise<void> => {
      if (cancelled || index >= candidates.length) {
        if (!cancelled) setPlan(null);
        return;
      }
      const path = candidates[index];
      try {
        const res = await fetch(`/api/files/${encodeFilePathForApi(path)}?type=read`);
        if (!res.ok) {
          await readCandidate(index + 1);
          return;
        }
        const d = (await res.json()) as { content?: string; error?: string };
        if (cancelled) return;
        if (typeof d.content !== "string") {
          await readCandidate(index + 1);
          return;
        }
        setPlan({ path, summary: planSummary(d.content) });
        // Live refresh while the widget is mounted.
        es = new EventSource(`/api/files/${encodeFilePathForApi(path)}?type=watch`);
        es.addEventListener("change", () => {
          void (async () => {
            try {
              const r = await fetch(`/api/files/${encodeFilePathForApi(path)}?type=read`);
              if (!r.ok) return;
              const next = (await r.json()) as { content?: string };
              if (!cancelled && typeof next.content === "string") {
                setPlan({ path, summary: planSummary(next.content) });
              }
            } catch {
              // keep the old summary
            }
          })();
        });
      } catch {
        await readCandidate(index + 1);
      }
    };
    void readCandidate(0);

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [cwd]);

  return (
    <div
      className="chat-status-widget"
      style={{
        position: "absolute",
        top: 12,
        right: 36,
        zIndex: 45,
        display: "flex",
        gap: 6,
        alignItems: "center",
        pointerEvents: "auto",
      }}
    >
      {plan && (
        <button
          type="button"
          onClick={onOpenPlan}
          title={plan.path}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            maxWidth: 280, overflow: "hidden",
            padding: "3px 10px", borderRadius: 999,
            fontSize: 11, cursor: "pointer",
            background: planActive ? "var(--bg-selected)" : "var(--bg-panel)",
            color: "var(--text)",
            border: `1px solid ${planActive ? "var(--accent)" : "var(--border)"}`,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{plan.summary}</span>
        </button>
      )}
      <Chip
        label="进程"
        title="等待 TODO 工具接入"
        disabled
        icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7" /></svg>}
      />
      <Chip
        label="终端"
        title="等待终端工具接入"
        disabled
        icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>}
      />
      <button
        type="button"
        onClick={onOpenAgents}
        title="子智能体目录"
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "3px 10px", borderRadius: 999,
          fontSize: 11, cursor: "pointer",
          background: "var(--bg-panel)", color: "var(--text)",
          border: "1px solid var(--border)",
        }}
      >
        {runningCount > 0 ? (
          <span className="chat-status-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4" /><circle cx="9" cy="14" r="0.6" /><circle cx="15" cy="14" r="0.6" />
          </svg>
        )}
        <span>智能体</span>
        {runningCount > 0 && <span style={{ color: "var(--accent)", fontWeight: 700 }}>{runningCount}</span>}
      </button>
    </div>
  );
}

function Chip({ label, title, icon, disabled }: { label: string; title: string; icon: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 10px", borderRadius: 999,
        fontSize: 11,
        background: "var(--bg-panel)",
        color: "var(--text-dim)",
        border: "1px dashed var(--border)",
        cursor: "not-allowed",
        opacity: 0.65,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** First meaningful line of the plan file, trimmed for the chip. */
function planSummary(content: string): string {
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
  return "计划";
}
