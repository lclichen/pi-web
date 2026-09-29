"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentCall } from "@/hooks/useAgentSession";
import type { SessionPlan } from "@/hooks/use-session-plan";
import type { TodoItem } from "@/lib/extensions/todo-protocol";
import {
  buildCollapsedSummary,
  capsuleVisible,
  todoFocusWindow,
  type CapsuleGitSummary,
} from "@/lib/chat-status-model";

/** Session todo items as published by the todo extension ("todo-list" widget). */
export type CapsuleTodo = TodoItem;

/** Background-shell task as published by the bg-shell extension ("bg-tasks"). */
export interface CapsuleBgTask {
  taskId: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled" | "lost";
  startedAt: number;
  pid: string;
  outputFile: string;
}

interface Props {
  subagentCalls: SubagentCall[];
  onOpenAgents: () => void;
  onOpenPlan: () => void;
  /** Owning session id — used to stop background subagent runs. */
  sessionId?: string | null;
  /** Session working directory — drives the lightweight git-summary poll. */
  cwd?: string | null;
  /** Bump to force a git-summary refresh (e.g. on agent end). */
  refreshSignal?: number;
  /** Agent generating (activity chain input). */
  agentRunning?: boolean;
  /** A shell command is executing (activity chain input). */
  bashRunning?: boolean;
  /** Background-shell tasks (bg-shell extension) — 任务 section + chain. */
  bgTasks?: CapsuleBgTask[];
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
 * Floating status capsule at the top-right of the conversation (ZCode
 * ConversationStatusPanel 对标，见 harness-research/07).
 *
 * 折叠兜底链（lib/chat-status-model 的 buildCollapsedSummary）:
 *   TODO 当前步 → 目标 → git ±N → 会话计划 → 运行活动计数 → idle(整体退场)
 *
 * 同一 shell 的两态形变（ZCode 同款）：折叠 pill 与展开 panel 是同一个
 * 容器——mini 宽度经隐藏测量元素 + ResizeObserver 实测（两个状态都有
 * 显式宽度，width/radius/padding/shadow 才能平滑过渡）。auto 变体按对话
 * 容器宽度（≥1180px 默认展开、否则 mini），用户点击可覆盖，会话切换重置。
 *
 * Expanded sections: goal row / 进程（Todo >6 条聚焦窗口，折叠边缘带
 * title 预览）/ 智能体（运行中 + 停止；已结束收进"已结束 N"页脚目录）/
 * plan quick row（终端入口在文件浏览器工具栏——合并决策 1）。
 */
export function ChatStatusWidget({
  subagentCalls, onOpenAgents, onOpenPlan, sessionId,
  cwd = null, refreshSignal = 0, agentRunning = false, bashRunning = false,
  bgTasks = [],
  planActive,
  plan = null, todos = [], goal = null,
  planMode = null,
}: Props) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [processOpen, setProcessOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);
  const [bgOpen, setBgOpen] = useState(true);
  const [bgStoppingId, setBgStoppingId] = useState<string | null>(null);
  const [bgStopError, setBgStopError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [miniWidth, setMiniWidth] = useState<number | null>(null);
  const [wide, setWide] = useState(false);
  const [variantOverride, setVariantOverride] = useState<"panel" | "mini" | null>(null);

  const runningCalls = useMemo(
    () => subagentCalls.filter((c) => c.status === "running" || c.status === "background"),
    [subagentCalls],
  );
  const runningCount = runningCalls.length;
  const endedCalls = useMemo(
    () => subagentCalls.filter((c) => c.status !== "running" && c.status !== "background"),
    [subagentCalls],
  );

  // Elapsed-time ticker: only live while the panel is open with active runs.
  const panelOpen = (variantOverride ?? (wide ? "panel" : "mini")) === "panel";
  useEffect(() => {
    if (!panelOpen || runningCount === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [panelOpen, runningCount]);
  useEffect(() => { setAgentsOpen(runningCount > 0); }, [runningCount]);

  // ---- git summary poll (collapsed-chain input #3) ----------------------
  const [gitSummary, setGitSummary] = useState<CapsuleGitSummary | null>(null);
  useEffect(() => {
    if (!cwd) {
      setGitSummary(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { isGitRepository?: boolean; additions?: number; deletions?: number };
        if (cancelled) return;
        if (data?.isGitRepository) setGitSummary({ additions: data.additions ?? 0, deletions: data.deletions ?? 0 });
        else setGitSummary(null);
      } catch {
        // not a repo / offline — keep whatever we had
      }
    };
    void load();
    const timer = setInterval(load, 45_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cwd, refreshSignal]);

  // ---- auto variant: conversation container width (ZCode container-query
  //      equivalent via ResizeObserver — one DOM, no dual render) ----------
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWide(parent.clientWidth >= 1180));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  // mini-width measurement: a hidden clone of the header carries the natural
  // pill width; both shell states get explicit widths so the morph animates.
  useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setMiniWidth(Math.min(320, Math.ceil(el.getBoundingClientRect().width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Session switch resets the manual override + section open states (ZCode).
  const sessionKey = sessionId ?? cwd ?? "";
  useEffect(() => {
    setVariantOverride(null);
    setProcessOpen(true);
    setAgentsOpen(false);
    setShowEnded(false);
  }, [sessionKey]);

  // Close on outside click / Escape (the panel shares the shell with the
  // pill, so closing means falling back to mini).
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setVariantOverride("mini");
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setVariantOverride("mini"); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panelOpen]);

  const planSummaryText = plan ? planSummary(plan.content, t("app.plan")) : null;
  const planStep = plan ? planCurrentStep(plan.content) : null;

  // ---- the model truth (①②): one derivation, everything renders from it --
  const bgRunningCount = bgTasks.filter((x) => x.status === "running").length;
  const summary = useMemo(
    () => buildCollapsedSummary({
      todos,
      goal,
      git: gitSummary,
      runningSubagents: runningCount,
      endedSubagents: endedCalls.length,
      bashRunning,
      agentRunning,
      bgRunning: bgRunningCount,
      hasPlan: Boolean(plan),
    }),
    [todos, goal, gitSummary, runningCount, endedCalls.length, bashRunning, agentRunning, bgTasks, plan],
  );
  const visible = capsuleVisible(summary, planMode === "plan");

  const todoDone = todos.filter((x) => x.status === "completed").length;
  const formatElapsed = (startedAt: number): string => {
    const s = Math.max(0, Math.floor((now - startedAt) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600);
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

  const handleStopBg = async (taskId: string) => {
    if (!sessionId) return;
    setBgStoppingId(taskId);
    setBgStopError(null);
    try {
      const { sendAgentCommand } = await import("@/lib/agent-client");
      const r = (await sendAgentCommand(sessionId, { type: "stop_bg", taskId })) as { ok?: boolean; error?: string } | undefined;
      if (r && r.ok === false) setBgStopError(r.error ?? "停止失败");
    } catch (e) {
      setBgStopError(e instanceof Error ? e.message : String(e));
    } finally {
      setBgStoppingId(null);
    }
  };

  if (!visible) return null;

  const activityTotal = runningCount + (bashRunning || bgRunningCount > 0 ? 1 : 0) + (agentRunning ? 1 : 0);
  // Leading icon + pinned text per chain kind. Activity keeps the live pulse;
  // single-class activity uses that class's glyph, mixed uses the wave (ZCode).
  let leadingIcon: React.ReactNode;
  let pinnedText: string;
  let trailingChip: React.ReactNode = null;
  switch (summary.kind) {
    case "todo":
      leadingIcon = <IconCart />;
      pinnedText = summary.step;
      trailingChip = <span style={{ ...chipStyle }}>{summary.done}/{summary.total}</span>;
      break;
    case "goal":
      leadingIcon = <IconTarget />;
      pinnedText = summary.text;
      break;
    case "git":
      leadingIcon = <IconBranch />;
      pinnedText = "";
      trailingChip = (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, flexShrink: 0 }}>
          <span style={{ color: "var(--success, #22c55e)" }}>+{summary.additions}</span>
          {" "}
          <span style={{ color: "#f87171" }}>−{summary.deletions}</span>
        </span>
      );
      break;
    case "plan":
      leadingIcon = <IconPlan />;
      pinnedText = planStep ?? planSummaryText ?? t("app.plan");
      break;
    case "activity":
      leadingIcon = <span className="chat-status-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />;
      if (summary.mixed) {
        leadingIcon = (
          <>
            <IconWave />
            <span className="chat-status-pulse" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", flexShrink: 0 }} />
          </>
        );
        pinnedText = t("chat.status.activityMixed", { count: activityTotal });
      } else if (summary.subagents > 0) {
        leadingIcon = <IconUsers />;
        pinnedText = t("chat.status.activitySubagents", { count: summary.subagents });
      } else if (summary.bash || bgRunningCount > 0) {
        leadingIcon = <IconTerminal />;
        pinnedText = bgRunningCount > 0
          ? t("chat.status.activityBg", { count: bgRunningCount })
          : t("chat.status.activityBash");
      } else {
        pinnedText = t("chat.status.activityAgent");
      }
      break;
    default:
      leadingIcon = <IconWave />;
      pinnedText = t("chat.status");
  }
  if (summary.kind === "todo" && runningCount > 0) {
    trailingChip = (
      <>
        {trailingChip}
        <span style={{ color: "var(--accent)", fontWeight: 700, flexShrink: 0 }}>{runningCount}</span>
      </>
    );
  }
  if (summary.kind !== "todo" && runningCount > 0) {
    trailingChip = <span style={{ color: "var(--accent)", fontWeight: 700, flexShrink: 0 }}>{runningCount}</span>;
  }

  const pillTitle =
    summary.kind === "git" ? t("chat.status.gitSummary") : t("chat.status.panelTitle");

  const headerRow = (
    <>
      {hovered && !panelOpen ? <IconExpand /> : leadingIcon}
      {pinnedText ? (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500, minWidth: 0 }}>
          {pinnedText}
        </span>
      ) : null}
      {trailingChip}
      <svg
        width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        style={{ transform: panelOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
      >
        <polyline points="2 4 5 7 8 4" />
      </svg>
    </>
  );

  const headerButton = (
    <button
      type="button"
      onClick={() => setVariantOverride(panelOpen ? "mini" : "panel")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-expanded={panelOpen}
      aria-haspopup="menu"
      title={pillTitle}
      className="chat-status-capsule"
      style={{
        display: "flex", alignItems: "center", gap: 7, width: "100%", minWidth: 0,
        padding: panelOpen ? "8px 12px" : "4px 11px",
        fontSize: 11.5, cursor: "pointer", textAlign: "left",
        background: "transparent",
        color: hovered && !panelOpen ? "var(--accent)" : "var(--text)",
        border: "none",
        transition: "padding 0.22s ease, color 0.12s",
      }}
    >
      {headerRow}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="chat-status-widget"
      style={{ position: "absolute", top: 12, right: 36, zIndex: 45, pointerEvents: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}
    >
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

      {/* Same shell for both states (ZCode): pill and panel are one container
          morphing between them; the mini width comes from the hidden clone. */}
      <div
        role={panelOpen ? "menu" : undefined}
        style={{
          width: panelOpen ? Math.min(340, typeof window === "undefined" ? 340 : window.innerWidth - 48) : (miniWidth ?? undefined),
          maxWidth: 340,
          background: panelOpen || hovered ? "color-mix(in srgb, var(--accent) 7%, var(--bg-panel))" : "var(--bg-panel)",
          border: `1px solid ${panelOpen || hovered ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
          borderRadius: panelOpen ? 10 : 999,
          boxShadow: panelOpen ? "0 10px 28px rgba(0,0,0,0.14)" : "none",
          overflow: "hidden",
          display: "flex", flexDirection: "column",
          transition: "width 0.22s ease, border-radius 0.22s ease, box-shadow 0.22s ease, background 0.12s, border-color 0.12s",
        }}
      >
        {headerButton}
        {panelOpen && (
          <div style={{ maxHeight: "min(64dvh, 420px)", overflowY: "auto", display: "flex", flexDirection: "column" }}>
            {/* Goal row */}
            {(goal || summary.kind === "todo") && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "2px 12px 8px" }}>
                <span style={{
                  flexShrink: 0, fontSize: 10, lineHeight: "17px", padding: "0 6px", borderRadius: 999,
                  background: "var(--bg-selected)", color: "var(--text-muted)", fontWeight: 600,
                }}>{t("chat.status.goals")}</span>
                <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--text)", lineHeight: "17px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {goal ?? pinnedText}
                </div>
                {todos.length > 0 && (
                  <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: "17px" }}>
                    {todoDone}/{todos.length}
                  </span>
                )}
              </div>
            )}

            {/* 进程 section — long lists use the focus window (④) */}
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
                  {todoFocusWindow(todos).map((entry, idx) =>
                    entry.type === "marker" ? (
                      <div
                        key={`marker-${idx}`}
                        title={entry.hidden.map((h) => h.content).join("\n")}
                        style={{ padding: "2px 4px", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", letterSpacing: 2, textAlign: "center" }}
                      >
                        ···
                        <span style={{ letterSpacing: 0, marginLeft: 6 }}>
                          {t("chat.status.hiddenSteps", { count: entry.hidden.length })}
                        </span>
                      </div>
                    ) : (
                      <TodoRow key={entry.item.id} todo={entry.item} currentId={currentTodoId(todos)} />
                    ),
                  )}
                </div>
              )}
            </Section>

            {/* 智能体 section — running up top; ended collapse into a footer
                directory row (④, ZCode "已结束 N ›"). */}
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
                  {runningCalls.map((call) => (
                    <AgentRow
                      key={call.key}
                      call={call}
                      now={now}
                      stopping={stoppingIds.has(call.key)}
                      stopEnabled={Boolean(sessionId)}
                      onStop={() => { void handleStop(call); }}
                      onOpen={() => { onOpenAgents(); setVariantOverride("mini"); }}
                      stopTitle={t("chat.status.stopTask")}
                      runtimeTitle={t("chat.status.runtime")}
                    />
                  ))}
                  {endedCalls.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowEnded((v) => !v)}
                      aria-expanded={showEnded}
                      style={{
                        display: "flex", alignItems: "center", gap: 6, width: "100%",
                        padding: "4px 6px", border: "none", borderRadius: 5, background: "transparent",
                        color: "var(--text-dim)", fontSize: 10.5, cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" style={{ flexShrink: 0, transform: showEnded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
                        <path d="M3 1l5 4-5 4z" fill="currentColor" />
                      </svg>
                      {t("chat.status.endedCollapsed", { count: endedCalls.length })}
                    </button>
                  )}
                  {showEnded && endedCalls.map((call) => (
                    <AgentRow
                      key={call.key}
                      call={call}
                      now={now}
                      stopping={false}
                      stopEnabled={false}
                      onStop={() => {}}
                      onOpen={() => { onOpenAgents(); setVariantOverride("mini"); }}
                      stopTitle={t("chat.status.stopTask")}
                      runtimeTitle={t("chat.status.runtime")}
                    />
                  ))}
                  {stopError && (
                    <div style={{ padding: "2px 6px", fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{stopError}</div>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { onOpenAgents(); setVariantOverride("mini"); }}
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

            {/* 任务 section — bg-shell background tasks (dev servers etc.) */}
            {bgTasks.length > 0 && (
              <Section
                title={t("chat.status.bgTasks")}
                open={bgOpen}
                onToggle={() => setBgOpen((v) => !v)}
                count={`${bgRunningCount}/${bgTasks.length}`}
              >
                <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
                  {bgTasks.map((task) => (
                    <div key={task.taskId} style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setVariantOverride("mini"); }}
                        title={`${task.outputFile} (pid ${task.pid})`}
                        style={{
                          display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0,
                          padding: "4px 6px", border: "none", borderRadius: 5, background: "transparent",
                          color: "var(--text)", fontSize: 11, textAlign: "left", cursor: "pointer",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                      >
                        {task.status === "running" ? (
                          <span className="chat-status-pulse" style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: "var(--accent)" }} />
                        ) : (
                          <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: task.status === "failed" ? "#f87171" : "var(--text-dim)" }} />
                        )}
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {task.name}
                        </span>
                      </button>
                      {task.status === "running" && (
                        <>
                          <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", minWidth: 34, textAlign: "right" }} title={t("chat.status.runtime")}>
                            {formatElapsedStatic(now, task.startedAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() => { void handleStopBg(task.taskId); }}
                            disabled={!sessionId || bgStoppingId === task.taskId}
                            title={t("chat.status.stopTask")}
                            aria-label={t("chat.status.stopTask")}
                            style={{
                              flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                              width: 18, height: 18, padding: 0, border: "none", borderRadius: 4,
                              background: "transparent", color: bgStoppingId === task.taskId ? "var(--text-dim)" : "#f87171",
                              cursor: bgStoppingId === task.taskId ? "default" : "pointer",
                            }}
                            onMouseEnter={(e) => { if (bgStoppingId !== task.taskId) e.currentTarget.style.background = "rgba(248,113,113,0.12)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                          >
                            {bgStoppingId === task.taskId
                              ? <span style={{ fontSize: 9 }}>…</span>
                              : <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {bgStopError && (
                    <div style={{ padding: "2px 6px", fontSize: 10, color: "#f87171", overflowWrap: "anywhere" }}>{bgStopError}</div>
                  )}
                </div>
              </Section>
            )}

            {/* Plan quick row — the terminal entry lives in the file explorer
                toolbar (merge decision 1); background tasks got their own stop
                controls in the 任务 section above. */}
            <div style={{ borderTop: "1px solid var(--border)", padding: 3, display: "flex", flexDirection: "column" }}>
              {plan && (
                <Row
                  onClick={() => { onOpenPlan(); setVariantOverride("mini"); }}
                  title={plan.path}
                  active={planActive}
                  icon={<IconPlan width={12} height={12} />}
                  label={planSummaryText ?? t("app.plan")}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Hidden measuring clone: carries the natural mini width for the
          shell's width transition (never visible, never interactive). */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 7, padding: "4px 11px", fontSize: 11.5, fontWeight: 500, left: -9999, top: 0 }}
      >
        {leadingIcon}
        <span>{pinnedText}</span>
        {summary.kind === "todo" && <span style={{ fontSize: 10, padding: "0 6px" }}>{todoDone}/{todos.length}</span>}
        <svg width="9" height="9" viewBox="0 0 10 10"><polyline points="2 4 5 7 8 4" /></svg>
      </div>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  flexShrink: 0, fontSize: 10, lineHeight: "16px", padding: "0 6px", borderRadius: 999,
  background: "var(--bg-selected)", color: "var(--text-muted)", fontFamily: "var(--font-mono)",
};

/** in_progress 优先、缺省回落首个 pending —— 与 model 层的链头一致。 */
function currentTodoId(todos: TodoItem[]): number | null {
  const current = todos.find((x) => x.status === "in_progress") ?? todos.find((x) => x.status === "pending") ?? null;
  return current?.id ?? null;
}

function TodoRow({ todo, currentId }: { todo: TodoItem; currentId: number | null }) {
  const isDone = todo.status === "completed";
  const isRunning = todo.status === "in_progress";
  const isCurrent = currentId === todo.id;
  return (
    <div
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
}

function AgentRow({ call, now, stopping, stopEnabled, onStop, onOpen, stopTitle, runtimeTitle }: {
  call: SubagentCall;
  now: number;
  stopping: boolean;
  stopEnabled: boolean;
  onStop: () => void;
  onOpen: () => void;
  stopTitle: string;
  runtimeTitle: string;
}) {
  const isRunning = call.status === "running" || call.status === "background";
  const isBackground = call.status === "background";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%" }}>
      <button
        type="button"
        role="menuitem"
        onClick={onOpen}
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
        <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", minWidth: 34, textAlign: "right" }} title={runtimeTitle}>
          {formatElapsedStatic(now, call.startedAt)}
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
          onClick={onStop}
          disabled={stopping || !stopEnabled || !call.agentId}
          title={stopTitle}
          aria-label={stopTitle}
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
}

function formatElapsedStatic(now: number, startedAt: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

// ---- icons (11×11, stroke 2.2 — pill idiom) -------------------------------

function iconProps(width = 11, height = 11) {
  return {
    width, height, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true, style: { flexShrink: 0 } as React.CSSProperties,
  };
}
const IconCart = () => <svg {...iconProps()}><path d="M3 5h2l2 12h11" /><path d="M8 9h13" /><path d="M9.5 21a1 1 0 1 0 0-0.01" /><path d="M17.5 21a1 1 0 1 0 0-0.01" /></svg>;
const IconTarget = () => <svg {...iconProps()}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>;
const IconBranch = () => <svg {...iconProps()}><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>;
const IconPlan = ({ width, height }: { width?: number; height?: number }) => <svg {...iconProps(width ?? 11, height ?? 11)}><path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" /></svg>;
const IconWave = () => <svg {...iconProps()}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>;
const IconUsers = () => <svg {...iconProps()}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
const IconTerminal = () => <svg {...iconProps()}><path d="M4 17l6-6-6-6" /><line x1="12" y1="19" x2="20" y2="19" /></svg>;
const IconExpand = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
    <polyline points="13 5 19 5 19 11" /><line x1="19" y1="5" x2="9" y2="15" />
    <polyline points="5 13 5 19 11 19" />
  </svg>
);

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
