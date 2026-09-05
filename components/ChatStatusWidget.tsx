"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentCall } from "@/hooks/useAgentSession";
import type { SessionPlan } from "@/hooks/use-session-plan";

export interface CapsuleTodo {
  id: number;
  text: string;
  done: boolean;
}

interface Props {
  subagentCalls: SubagentCall[];
  onOpenAgents: () => void;
  onOpenPlan: () => void;
  onToggleTerminal?: () => void;
  /** Plan tab is active — highlight the plan row. */
  planActive?: boolean;
  /** Bottom terminal drawer is open — highlight the terminal row. */
  terminalActive?: boolean;
  /** Session plan (per-session file first, legacy workspace plans as
   *  fallback) — probed by AppShell via useSessionPlan and passed down. */
  plan?: SessionPlan | null;
  /** Session TODO items from the todo extension widget ("todo-list"). */
  todos?: CapsuleTodo[];
  /** Minimal goal description (first user message of the session). */
  goal?: string | null;
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
 * Expanded — a popover with the goal row on top and two collapsible sections
 * (进程 = TODO list, 智能体 = subagent calls), each with a ▸/▾ triangle and a
 * count on the right; plan and terminal quick rows sit at the bottom.
 */
export function ChatStatusWidget({
  subagentCalls, onOpenAgents, onOpenPlan, onToggleTerminal, planActive, terminalActive,
  plan = null, todos = [], goal = null,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [processOpen, setProcessOpen] = useState(true);
  const runningCount = useMemo(
    () => subagentCalls.filter((c) => c.status === "running" || c.status === "background").length,
    [subagentCalls],
  );
  const [agentsOpen, setAgentsOpen] = useState(false);
  useEffect(() => { setAgentsOpen(runningCount > 0); }, [runningCount]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const todoDone = todos.filter((x) => x.done).length;
  const currentTodo = todos.find((x) => !x.done) ?? null;

  const planSummaryText = plan ? planSummary(plan.content, t("计划")) : null;
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
    ? currentTodo.text
    : (planStep ?? planSummaryText ?? goal ?? t("状态"));
  const pinnedKind: "todo" | "plan" | "goal" | "idle"
    = currentTodo ? "todo"
      : plan ? "plan"
        : goal ? "goal"
          : "idle";
  const hasProgress = todos.length > 0;
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
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("会话状态：目标 / 进程 / 智能体 / 终端")}
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
              }}>{t("目标")}</span>
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
            title={t("进程")}
            open={processOpen}
            onToggle={() => setProcessOpen((v) => !v)}
            count={todos.length > 0 ? `${todoDone}/${todos.length}` : undefined}
          >
            {todos.length === 0 ? (
              <div style={{ padding: "4px 12px 9px", fontSize: 10.5, color: "var(--text-dim)", lineHeight: "15px" }}>
                {t("暂无步骤 —— 多步任务中模型会通过 todo 工具自动维护进度清单")}
              </div>
            ) : (
              <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column" }}>
                {todos.map((todo, index) => {
                  const isCurrent = currentTodo?.id === todo.id;
                  return (
                    <div
                      key={todo.id}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 7,
                        padding: "3px 4px", borderRadius: 5,
                        background: isCurrent ? "color-mix(in srgb, var(--accent) 9%, transparent)" : "transparent",
                        marginLeft: index === 0 ? 0 : 0,
                      }}
                    >
                      {todo.done ? (
                        <span style={{
                          flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1,
                          border: "1px solid var(--success, #22c55e)", background: "var(--success, #22c55e)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>
                          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l3.5 3.5L13 4" /></svg>
                        </span>
                      ) : isCurrent ? (
                        <span style={{
                          flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1,
                          border: "1.5px solid var(--accent)", color: "var(--accent)",
                          fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
                          display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
                        }}>
                          {index + 1}
                        </span>
                      ) : (
                        <span style={{ flexShrink: 0, width: 13, height: 13, borderRadius: 999, marginTop: 1, border: "1.5px solid var(--text-dim)" }} />
                      )}
                      <span style={{
                        flex: 1, minWidth: 0, fontSize: 11, lineHeight: "15px",
                        color: todo.done ? "var(--text-dim)" : isCurrent ? "var(--text)" : "var(--text-muted)",
                        textDecoration: todo.done ? "line-through" : "none",
                        overflowWrap: "anywhere",
                      }}>
                        {todo.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* 智能体 section */}
          <Section
            title={t("智能体")}
            open={agentsOpen}
            onToggle={() => setAgentsOpen((v) => !v)}
            count={subagentCalls.length > 0 ? String(subagentCalls.length) : undefined}
          >
            {subagentCalls.length === 0 ? (
              <div style={{ padding: "4px 12px 9px", fontSize: 10.5, color: "var(--text-dim)", lineHeight: "15px" }}>
                {t("暂无子智能体调用")}
              </div>
            ) : (
              <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
                {subagentCalls.slice(-8).reverse().map((call) => {
                  const isRunning = call.status === "running" || call.status === "background";
                  return (
                    <button
                      key={call.key}
                      type="button"
                      role="menuitem"
                      onClick={() => { onOpenAgents(); setOpen(false); }}
                      title={call.description}
                      style={{
                        display: "flex", alignItems: "center", gap: 7, width: "100%",
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
                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                        {isRunning ? t("运行中") : call.durationMs != null ? `${Math.round(call.durationMs / 1000)}s` : t("完成")}
                      </span>
                    </button>
                  );
                })}
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
                  {t("打开子智能体目录")}
                </button>
              </div>
            )}
          </Section>

          {/* Plan + terminal quick rows */}
          <div style={{ borderTop: "1px solid var(--border)", padding: 3, display: "flex", flexDirection: "column" }}>
            {plan && (
              <Row
                onClick={() => { onOpenPlan(); setOpen(false); }}
                title={plan.path}
                active={planActive}
                icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" /></svg>}
                label={planSummaryText ?? t("计划")}
              />
            )}
            {onToggleTerminal && (
              <Row
                onClick={() => { onToggleTerminal(); setOpen(false); }}
                title={t("底部终端（工作区 shell）")}
                active={terminalActive}
                icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>}
                label={t("终端")}
                trailing={terminalActive ? <span style={{ fontSize: 10 }}>{t("已打开")}</span> : undefined}
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
