"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentCall } from "@/hooks/useAgentSession";
import type { SessionPlan } from "@/hooks/use-session-plan";
import type { TodoItem } from "@/lib/extensions/todo-protocol";

/** Session todo items as published by the todo extension ("todo-list" widget). */
export type CapsuleTodo = TodoItem;

interface Props {
  subagentCalls: SubagentCall[];
  onOpenAgents: () => void;
  onOpenPlan: () => void;
  /** Owning session id — used to stop background subagent runs. */
  sessionId?: string | null;
  /** Plan tab is active — highlight the plan row. */
  planActive?: boolean;
  /** Session plan (per-session file first, legacy workspace plans as
   *  fallback) — probed by AppShell via useSessionPlan and passed down. */
  plan?: SessionPlan | null;
  /** Session TODO items from the todo extension widget ("todo-list"). */
  todos?: CapsuleTodo[];
  /** Minimal goal description (first user message of the session). */
  goal?: string | null;
  /** Collaboration mode from the plan-mode extension ("plan" shows a badge). */
  planMode?: "execute" | "plan" | null;
}

/**
 * Floating status capsule at the top-right of the conversation (ZCode-style).
 *
 * Collapsed — one pill, three pinned modes (highest priority first):
 *   1. 计划/TODO: checklist icon + the currently executing step (first undone)
 *      + progress chip (n/m)
 *   2. 目标: target icon + the minimal goal description
 *   3. fallback 状态
 * Hovering recolors the pill (accent tint) and swaps the leading icon for a
 * ↗ expand glyph, signalling "click to open". A running-agent pulse + count is
 * appended whenever subagents are active.
 *
 * Expanded — a popover with the goal row on top, two collapsible sections
 * (进程 = TODO list, 智能体 = subagent/background-task list with elapsed time
 * and a stop button per background run), and a plan quick row at the bottom.
 * (The terminal entry moved to the file explorer toolbar — merge decision 1.)
 */
export function ChatStatusWidget({
  subagentCalls, onOpenAgents, onOpenPlan, sessionId,
  planActive,
  plan = null, todos = [], goal = null,
  planMode = null,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [processOpen, setProcessOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);
  const runningCount = useMemo(
    () => subagentCalls.filter((c) => c.status === "running" || c.status === "background").length,
    [subagentCalls],
  );
  // Elapsed-time ticker: only live while the popover is open with active runs.
  useEffect(() => {
    if (!open || runningCount === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, runningCount]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  useEffect(() => { setAgentsOpen(runningCount > 0); }, [runningCount]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const todoDone = todos.filter((x) => x.status === "completed").length;
  // in_progress is authoritative; fall back to the first pending step so the
  // capsule still pins something between writes (e.g. right after creation).
  const currentTodo = todos.find((x) => x.status === "in_progress") ?? todos.find((x) => x.status === "pending") ?? null;

  const planSummaryText = plan ? planSummary(plan.content, t("app.plan")) : null;
  const planStep = plan ? planCurrentStep(plan.content) : null;

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

  // Pinned capsule text: current TODO step → plan step → goal → 状态.
  const pinnedText = currentTodo
    ? (currentTodo.status === "in_progress" ? (currentTodo.activeForm ?? currentTodo.content) : currentTodo.content)
    : (planStep ?? planSummaryText ?? goal ?? t("chat.status"));
  const pinnedKind: "todo" | "plan" | "goal" | "idle"
    = currentTodo ? "todo"
      : plan ? "plan"
        : goal ? "goal"
          : "idle";
  const hasProgress = todos.length > 0;
  const anyActive = planActive;

  const formatElapsed = (startedAt: number): string => {
    const s = Math.max(0, Math.floor((now - startedAt) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  };

  const handleStop = async (call: SubagentCall) => {
    if (!sessionId || !call.agentId) return;
    setStoppingIds((prev) => new Set(prev).add(call.key));
    setStopError(null);
    try {
      const { sendAgentCommand } = await import("@/lib/agent-client");
      await sendAgentCommand(sessionId, { type: "stop_subagent", agentId: call.agentId });
    } catch (e) {
      setStopError(e instanceof Error ? e.message : String(e));
    } finally {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(call.key);
        return next;
      });
    }
  };

  return (
    <div
      ref={rootRef}
      className="chat-status-widget"
      style={{ position: "absolute", top: 12, right: 36, zIndex: 45, pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}
    >
      {/* PLAN mode badge — read-only planning is active (plan-mode extension).
          Clicking it opens the plan panel where the saved plan lives. */}
      {planMode === "plan" && (
        <button
          type="button"
          onClick={onOpenPlan}
          title={t("chat.status.planModeHint")}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "2px 9px", borderRadius: 999,
            fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            background: "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))",
            color: "var(--accent)",
            border: "1px solid var(--accent)",
          }}
        >
          ⏸ PLAN
        </button>
      )}
      {/* The single capsule */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("chat.status.panelTitle")}
        className="chat-status-capsule"
        style={{
          display: "flex", alignItems: "center", gap: 7,
          maxWidth: 340, overflow: "hidden",
          padding: "4px 11px", borderRadius: 999,
          fontSize: 11.5, cursor: "pointer",
          background: open || hovered || anyActive
            ? "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))"
            : "var(--bg-panel)",
          color: open || hovered || anyActive ? "var(--accent)" : "var(--text)",
          border: `1px solid ${open || hovered || anyActive ? "var(--accent)" : "var(--border)"}`,
          transition: "background 0.12s, border-color 0.12s, color 0.12s",
        }}
      >
        {/* Leading icon: ↗ expand glyph on hover; mode icon otherwise. */}
        {hovered && !open ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <polyline points="13 5 19 5 19 11" /><line x1="19" y1="5" x2="9" y2="15" />
            <polyline points="5 13 5 19 11 19" />
          </svg>
        ) : runningCount > 0 ? (
          <span className="chat-status-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />
        ) : pinnedKind === "todo" ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M3 5h2l2 12h11" /><path d="M8 9h13" /><path d="M9.5 21a1 1 0 1 0 0-0.01" /><path d="M17.5 21a1 1 0 1 0 0-0.01" />
          </svg>
        ) : pinnedKind === "plan" ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" />
          </svg>
        ) : pinnedKind === "goal" ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
          {pinnedText}
        </span>
        {hasProgress && (
          <span style={{
            flexShrink: 0, fontSize: 10, lineHeight: "16px", padding: "0 6px", borderRadius: 999,
            background: "var(--bg-selected)", color: "var(--text-muted)", fontFamily: "var(--font-mono)",
          }}>
            {todoDone}/{todos.length}
          </span>
        )}
        {!hasProgress && runningCount > 0 && (
          <span style={{ color: "var(--accent)", fontWeight: 700, flexShrink: 0 }}>{runningCount}</span>
        )}
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
        >
          <polyline points="2 4 5 7 8 4" />
        </svg>
      </button>

      {/* Expanded popover */}
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            width: 340, maxWidth: "min(340px, calc(100vw - 48px))",
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.14)", overflow: "hidden",
            display: "flex", flexDirection: "column",
          }}
        >
          {/* Goal row */}
          {(goal || hasProgress) && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 11px 8px" }}>
              <span style={{
                flexShrink: 0, fontSize: 10, lineHeight: "17px", padding: "0 6px", borderRadius: 999,
                background: "var(--bg-selected)", color: "var(--text-muted)", fontWeight: 600,
              }}>{t("chat.status.goals")}</span>
              <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--text)", lineHeight: "17px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {goal ?? pinnedText}
              </div>
              {hasProgress && (
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: "17px" }}>
                  {todoDone}/{todos.length}
                </span>
              )}
            </div>
          )}

          {/* 进程 section */}
          <Section
            title={t("chat.processes")}
            open={processOpen}
            onToggle={() => setProcessOpen((v) => !v)}
            count={todos.length > 0 ? `${todoDone}/${todos.length}` : undefined}
          >
            {todos.length === 0 ? (
              <div style={{ padding: "4px 12px 9px", fontSize: 10.5, color: "var(--text-dim)", lineHeight: "15px" }}>
                {t("chat.status.noSteps")}
              </div>
            ) : (
              <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column" }}>
                {todos.map((todo) => {
                  const isDone = todo.status === "completed";
                  const isRunning = todo.status === "in_progress";
                  const isCurrent = currentTodo?.id === todo.id;
                  return (
                    <div
                      key={todo.id}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 7,
                        padding: "3px 4px", borderRadius: 5,
                        background: isCurrent ? "color-mix(in srgb, var(--accent) 9%, transparent)" : "transparent",
                      }}
                    >
                      {isDone ? (
                        <span style={{
                          flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1,
                          border: "1px solid var(--success, #22c55e)", background: "var(--success, #22c55e)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l3.5 3.5L13 4" /></svg>
                        </span>
                      ) : isRunning ? (
                        <span
                          className="chat-status-pulse"
                          style={{
                            flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1,
                            border: "1.5px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 35%, transparent)",
                          }}
                        />
                      ) : isCurrent ? (
                        <span style={{
                          flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1,
                          border: "1.5px solid var(--accent)", color: "var(--accent)",
                          fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
                          display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
                        }}>
                          {todo.id}
                        </span>
                      ) : (
                        <span style={{ flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1, border: "1.5px solid var(--text-dim)" }} />
                      )}
                      <span style={{
                        flex: 1, minWidth: 0, fontSize: 11, lineHeight: "15px",
                        color: isDone ? "var(--text-dim)" : isCurrent ? "var(--text)" : "var(--text-muted)",
                        textDecoration: isDone ? "line-through" : "none",
                        overflowWrap: "anywhere",
                      }}>
                        {isRunning && todo.activeForm ? todo.activeForm : todo.content}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* 智能体 section */}
          <Section
            title={t("app.agents")}
            open={agentsOpen}
            onToggle={() => setAgentsOpen((v) => !v)}
            count={subagentCalls.length > 0 ? String(subagentCalls.length) : undefined}
          >
            {subagentCalls.length === 0 ? (
              <div style={{ padding: "4px 12px 9px", fontSize: 10.5, color: "var(--text-dim)", lineHeight: "15px" }}>
                {t("chat.status.noSubagents")}
              </div>
            ) : (
              <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
                {subagentCalls.slice(-8).reverse().map((call) => {
                  const isRunning = call.status === "running" || call.status === "background";
                  const isBackground = call.status === "background";
                  const stopping = stoppingIds.has(call.key);
                  return (
                    <div
                      key={call.key}
                      style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { onOpenAgents(); setOpen(false); }}
                        title={call.description}
                        style={{
                          display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0,
                          padding: "4px 6px", border: "none", borderRadius: 5, background: "transparent",
                          color: "var(--text)", fontSize: 11, textAlign: "left", cursor: "pointer",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        {isRunning ? (
                          <span className="chat-status-pulse" style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: "var(--accent)" }} />
                        ) : (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: call.status === "error" ? "#f87171" : "var(--text-dim)" }}>
                            {call.status === "error"
                              ? <><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></>
                              : <><path d="M20 6L9 17l-5-5" /></>}
                          </svg>
                        )}
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {call.agentId || call.type}
                        </span>
                      </button>
                      {isRunning && (
                        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", minWidth: 34, textAlign: "right" }} title={t("chat.status.runtime")}>
                          {formatElapsed(call.startedAt)}
                        </span>
                      )}
                      {!isRunning && call.durationMs != null && (
                        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                          {Math.round(call.durationMs / 1000)}s
                        </span>
                      )}
                      {isBackground && (
                        <button
                          type="button"
                          onClick={() => { void handleStop(call); }}
                          disabled={stopping || !sessionId || !call.agentId}
                          title={t("chat.status.stopTask")}
                          aria-label={t("chat.status.stopTask")}
                          style={{
                            flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                            width: 18, height: 18, padding: 0, border: "none", borderRadius: 4,
                            background: "transparent", color: stopping ? "var(--text-dim)" : "#f87171",
                            cursor: stopping ? "default" : "pointer",
                          }}
                          onMouseEnter={(e) => { if (!stopping) e.currentTarget.style.background = "rgba(248,113,113,0.12)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                        >
                          {stopping
                            ? <span style={{ fontSize: 9 }}>…</span>
                            : <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>}
                        </button>
                      )}
                    </div>
                  );
                })}
                {stopError && (
                  <div style={{ padding: "2px 6px", fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{stopError}</div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onOpenAgents(); setOpen(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 7, width: "100%",
                    padding: "4px 6px", border: "none", borderRadius: 5, background: "transparent",
                    color: "var(--text-dim)", fontSize: 10.5, cursor: "pointer", textAlign: "left",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M9 18l6-6-6-6" /></svg>
                  {t("chat.status.openSubagents")}
                </button>
              </div>
            )}
          </Section>

          {/* Plan quick row — the terminal entry lives in the file explorer
              toolbar (merge decision 1); background tasks got their own stop
              controls in the 智能体 section above. */}
          <div style={{ borderTop: "1px solid var(--border)", padding: 3, display: "flex", flexDirection: "column" }}>
            {plan && (
              <Row
                onClick={() => { onOpenPlan(); setOpen(false); }}
                title={plan.path}
                active={planActive}
                icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" /></svg>}
                label={planSummaryText ?? t("app.plan")}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Collapsible popover section: ▸/▾ triangle + title + right count, hairline under the header. */
function Section({ title, open, onToggle, count, children }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          padding: "7px 11px", border: "none", background: "transparent",
          color: "var(--text)", fontSize: 11, fontWeight: 600, cursor: "pointer",
          borderBottom: open ? "1px solid color-mix(in srgb, var(--border) 60%, transparent)" : "none",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s", color: "var(--text-dim)" }}>
          <path d="M3 1l5 4-5 4z" fill="currentColor" />
        </svg>
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        {count && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontWeight: 500 }}>{count}</span>}
      </button>
      {open && <div>{children}</div>}
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
    if (!line || line.startsWith("#") || line.startsWith("---") || line.startsWith("<!--")) continue;
    return line.length > 60 ? line.slice(0, 60) + "…" : line;
  }
  const firstHeading = content.split("\n").find((l) => l.trim().startsWith("#"));
  if (firstHeading) {
    const text = firstHeading.replace(/^#+\s*/, "").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }
  return fallback;
}

/** First unchecked checkbox item of the plan file — the "current step". */
function planCurrentStep(content: string): string | null {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^[-*]\s+\[ \]\s+(.*)$/);
    if (match && match[1].trim()) {
      const text = match[1].trim();
      return text.length > 60 ? text.slice(0, 60) + "…" : text;
    }
  }
  return null;
}
