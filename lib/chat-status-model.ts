/**
 * Chat status capsule model — pure derivation layer (ZCode
 * conversationStatusPanelModel 的等价物，见 harness-research/07)。
 *
 * The ChatStatusWidget consumes this instead of deciding inline: the
 * collapsed-summary fallback chain, the running-activity icon semantics and
 * the long-todo focus window all live here as testable pure functions.
 * Future consumers (a composer-side activity badge) share the same truth.
 */
import type { TodoItem } from "./extensions/todo-protocol";

export interface CapsuleGitSummary {
  additions: number;
  deletions: number;
}

export interface CapsuleInputs {
  todos: TodoItem[];
  goal: string | null;
  /** Working-tree summary for the session cwd (null = not a repo / unknown). */
  git?: CapsuleGitSummary | null;
  /** Subagent runs currently running or backgrounded. */
  runningSubagents: number;
  /** Subagent runs already finished (ended/failed) in this session. */
  endedSubagents: number;
  bashRunning: boolean;
  agentRunning: boolean;
  hasPlan: boolean;
}

/** What the collapsed pill pins, in fallback-chain priority order. */
export type CollapsedSummary =
  | { kind: "todo"; step: string; done: number; total: number }
  | { kind: "goal"; text: string }
  | { kind: "git"; additions: number; deletions: number }
  | { kind: "plan" }
  | { kind: "activity"; subagents: number; bash: boolean; agent: boolean; mixed: boolean }
  | { kind: "idle" };

/**
 * Fallback chain (ZCode 对标，按我们的数据面裁剪):
 *   todo 当前步 → goal → git ±N → 会话计划 → 运行活动计数 → idle(隐藏)
 * "idle" 的语义是胶囊在空闲且无信号时整体退场，不占视觉位。
 */
export function buildCollapsedSummary(inputs: CapsuleInputs): CollapsedSummary {
  const current =
    inputs.todos.find((t) => t.status === "in_progress") ??
    inputs.todos.find((t) => t.status === "pending") ??
    null;
  if (current && inputs.todos.length > 0) {
    return {
      kind: "todo",
      step: current.status === "in_progress" && current.activeForm ? current.activeForm : current.content,
      done: inputs.todos.filter((t) => t.status === "completed").length,
      total: inputs.todos.length,
    };
  }
  if (inputs.goal) return { kind: "goal", text: inputs.goal };
  const git = inputs.git;
  if (git && git.additions + git.deletions > 0) {
    return { kind: "git", additions: git.additions, deletions: git.deletions };
  }
  if (inputs.hasPlan) return { kind: "plan" };
  if (inputs.runningSubagents > 0 || inputs.bashRunning || inputs.agentRunning) {
    return {
      kind: "activity",
      subagents: inputs.runningSubagents,
      bash: inputs.bashRunning,
      agent: inputs.agentRunning,
      mixed:
        [inputs.runningSubagents > 0, inputs.bashRunning, inputs.agentRunning].filter(Boolean).length > 1,
    };
  }
  return { kind: "idle" };
}

/** The collapsed pill is rendered at all (idle ⇒ retire the capsule). */
export function capsuleVisible(summary: CollapsedSummary, planMode: boolean): boolean {
  return planMode || summary.kind !== "idle";
}

export type TodoWindowEntry =
  | { type: "item"; item: TodoItem }
  | { type: "marker"; hidden: TodoItem[] };

/**
 * Long-list focus window (ZCode 对标): with more than `threshold` steps the
 * 进程 section shows only the current step plus its ±`pad` neighbours; each
 * collapsed edge becomes ONE marker row carrying its hidden items (hover
 * preview via title). Short lists render in full.
 */
export function todoFocusWindow(
  todos: TodoItem[],
  options: { threshold?: number; pad?: number } = {},
): TodoWindowEntry[] {
  const threshold = options.threshold ?? 6;
  const pad = options.pad ?? 2;
  if (todos.length <= threshold) return todos.map((item) => ({ type: "item" as const, item }));
  const found = todos.findIndex((t) => t.status === "in_progress" || t.status === "pending");
  // All-done list (legacy state — v2 auto-clears): center on the LAST item so
  // the window shows the most recent work, not the stale head.
  const center = found === -1 ? todos.length - 1 : found;
  const from = Math.max(0, center - pad);
  const to = Math.min(todos.length - 1, center + pad);
  const out: TodoWindowEntry[] = [];
  let pendingHidden: TodoItem[] = [];
  const flush = () => {
    if (pendingHidden.length > 0) {
      out.push({ type: "marker", hidden: pendingHidden });
      pendingHidden = [];
    }
  };
  for (let i = 0; i < todos.length; i++) {
    if (i >= from && i <= to) {
      flush();
      out.push({ type: "item", item: todos[i]! });
    } else {
      pendingHidden.push(todos[i]!);
    }
  }
  flush();
  return out;
}
