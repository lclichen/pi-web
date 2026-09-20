/**
 * Batch task state — in-memory registry (globalThis, hot-reload safe) with
 * a JSONL sidecar for cross-restart visibility (finished tasks can be
 * queried after a pi-web restart; running tasks are marked stale).
 *
 * State machine (ACP-inspired):
 *   queued → running → completed | failed | cancelled
 *                 ↘ waiting_input → running (auto-responded)
 *   Any state can transition to cancelled (explicit cancel or timeout).
 */
export type BatchTaskState =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/** ACP StopReason + batch extensions. */
export type BatchStopReason =
  | "end_turn"
  | "max_tokens"
  | "timeout"
  | "cancelled"
  | "refusal"
  | "error";

export interface BatchTaskUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
}

export interface BatchToolCallRecord {
  name: string;
  argumentsSummary: string;
  resultSummary: string;
  isError: boolean;
  durationMs: number;
}

export interface BatchFileArtifact {
  path: string;
  size: number;
}

export interface BatchTask {
  taskId: string;
  sessionId: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  state: BatchTaskState;
  stopReason?: BatchStopReason;
  error?: string;

  // Request context
  mode: string;
  requestedWorkDir: string;
  actualWorkDir: string;
  prompt: string;
  model?: { provider: string; modelId: string };
  timeoutMs: number;
  inputTimeoutMs: number;
  stopContainer: boolean;
  containerId?: number;
  projectId?: number;

  // Results (populated at terminal states)
  finalResponse?: string;
  summary?: string;
  usage?: BatchTaskUsage;
  toolCallLog?: BatchToolCallRecord[];
  sessionFile?: string;
  artifacts?: BatchFileArtifact[];
}

export interface BatchTaskSummary {
  taskId: string;
  state: BatchTaskState;
  stopReason?: BatchStopReason;
  summary?: string;
  usage?: BatchTaskUsage;
  durationMs?: number;
  workDir: string;
  error?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __piWebBatchTasks: Map<string, BatchTask> | undefined;
}

function store(): Map<string, BatchTask> {
  if (!globalThis.__piWebBatchTasks) {
    globalThis.__piWebBatchTasks = new Map();
  }
  return globalThis.__piWebBatchTasks;
}

export function createTaskRecord(init: Omit<BatchTask, "createdAt" | "state">): BatchTask {
  const task: BatchTask = { ...init, createdAt: Date.now(), state: "queued" };
  store().set(task.taskId, task);
  return task;
}

export function getTask(taskId: string): BatchTask | undefined {
  return store().get(taskId);
}

export function updateTask(taskId: string, patch: Partial<BatchTask>): BatchTask | undefined {
  const task = store().get(taskId);
  if (!task) return undefined;
  Object.assign(task, patch);
  return task;
}

export function listTasks(limit = 50): BatchTask[] {
  return [...store().values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function toSummary(task: BatchTask): BatchTaskSummary {
  return {
    taskId: task.taskId,
    state: task.state,
    stopReason: task.stopReason,
    summary: task.summary,
    usage: task.usage,
    durationMs: task.endedAt && task.startedAt ? task.endedAt - task.startedAt : undefined,
    workDir: task.actualWorkDir,
    error: task.error,
  };
}

/** Terminal states — no further transitions possible. */
export function isTerminal(state: BatchTaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
