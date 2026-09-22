/**
 * Batch task state — in-memory registry (globalThis, hot-reload safe) with
 * a JSONL sidecar for cross-restart visibility (finished tasks can be
 * queried after a pi-web restart; running tasks are marked stale).
 *
 * State machine (ACP-inspired):
 *   queued → running → completed | failed | cancelled
 *                 ↘ waiting_input → running (auto-responded)
 *   Any state can transition to cancelled (explicit cancel or timeout).
 *   Terminal states are absorbing — late runner updates cannot resurrect
 *   a finished/cancelled task.
 *
 * Every task also carries an event channel (buffered, replayable) that the
 * SSE stream mode subscribes to: state transitions publish `status`/`result`
 * events, and the runner forwards live agent events. The buffer is capped;
 * on overflow the oldest events are dropped and the channel is flagged
 * truncated so reconnecting clients know the replay is partial.
 */
import { getBatchVersionInfo } from "./version-info.ts";

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

/** Full result payload — shape shared by GET /result and the SSE `result` event. */
export interface BatchTaskResult {
  taskId: string;
  sessionId: string;
  state: BatchTaskState;
  stopReason?: BatchStopReason;
  finalResponse?: string;
  usage?: BatchTaskUsage;
  toolCallLog?: BatchToolCallRecord[];
  artifacts?: BatchFileArtifact[];
  sessionFile?: string;
  durationMs?: number;
  workDir: string;
  error?: string;
}

/** SSE wire events for a batch task stream (envelope-wrapped on the wire). */
export type BatchTaskStreamEvent =
  | { type: "task_created"; taskId: string; state: BatchTaskState; versions: ReturnType<typeof getBatchVersionInfo> }
  | { type: "status"; state: BatchTaskState; stopReason?: BatchStopReason; summary?: string; error?: string }
  | { type: "agent_event"; agentEvent: Record<string, unknown> }
  | { type: "result"; result: BatchTaskResult; versions: ReturnType<typeof getBatchVersionInfo> };

/** Sequenced wire envelope — `seq` lets clients detect replay gaps. */
export interface BatchTaskEventEnvelope {
  seq: number;
  at: number;
  event: BatchTaskStreamEvent;
}

const EVENT_BUFFER_CAP = 500;

interface TaskEventChannel {
  listeners: Set<(env: BatchTaskEventEnvelope) => void>;
  buffer: BatchTaskEventEnvelope[];
  nextSeq: number;
  truncated: boolean;
}

declare global {
  var __piWebBatchTasks: Map<string, BatchTask> | undefined;
  var __piWebBatchTaskEvents: Map<string, TaskEventChannel> | undefined;
}

function store(): Map<string, BatchTask> {
  if (!globalThis.__piWebBatchTasks) {
    globalThis.__piWebBatchTasks = new Map();
  }
  return globalThis.__piWebBatchTasks;
}

function channels(): Map<string, TaskEventChannel> {
  if (!globalThis.__piWebBatchTaskEvents) {
    globalThis.__piWebBatchTaskEvents = new Map();
  }
  return globalThis.__piWebBatchTaskEvents;
}

/**
 * Publish an event into the task's channel: buffer (bounded) + fan-out to
 * live subscribers. Events published before any subscriber exists are
 * replayed by subscribeTaskEvents.
 */
export function publishTaskEvent(taskId: string, event: BatchTaskStreamEvent): void {
  const channel = channels().get(taskId);
  if (!channel) return;
  const env: BatchTaskEventEnvelope = { seq: channel.nextSeq++, at: Date.now(), event };
  channel.buffer.push(env);
  if (channel.buffer.length > EVENT_BUFFER_CAP) {
    channel.buffer.shift();
    channel.truncated = true;
  }
  for (const listener of [...channel.listeners]) {
    try {
      listener(env);
    } catch (e) {
      console.error("[batch] task event listener failed:", e);
    }
  }
}

/**
 * Subscribe to a task's events. Buffered events are replayed first (in seq
 * order), then live events are forwarded. Returns an unsubscribe function.
 */
export function subscribeTaskEvents(
  taskId: string,
  listener: (env: BatchTaskEventEnvelope) => void,
): () => void {
  const channel = channels().get(taskId);
  if (!channel) return () => {};
  const replay = [...channel.buffer];
  for (const env of replay) listener(env);
  channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
  };
}

/** Buffer state for reconnecting clients (truncation notice). */
export function getTaskEventBufferInfo(taskId: string): { firstSeq: number; truncated: boolean } | undefined {
  const channel = channels().get(taskId);
  if (!channel) return undefined;
  return { firstSeq: channel.buffer[0]?.seq ?? 0, truncated: channel.truncated };
}

export function createTaskRecord(init: Omit<BatchTask, "createdAt" | "state">): BatchTask {
  const task: BatchTask = { ...init, createdAt: Date.now(), state: "queued" };
  store().set(task.taskId, task);
  channels().set(task.taskId, { listeners: new Set(), buffer: [], nextSeq: 1, truncated: false });
  publishTaskEvent(task.taskId, {
    type: "task_created",
    taskId: task.taskId,
    state: "queued",
    versions: getBatchVersionInfo(),
  });
  return task;
}

export function getTask(taskId: string): BatchTask | undefined {
  return store().get(taskId);
}

export function updateTask(taskId: string, patch: Partial<BatchTask>): BatchTask | undefined {
  const task = store().get(taskId);
  if (!task) return undefined;
  const prevState = task.state;
  Object.assign(task, patch);
  if (patch.state !== undefined && patch.state !== prevState) {
    if (isTerminal(prevState)) {
      // Terminal states are absorbing: a late runner update (e.g. the prompt
      // promise resolving after a cancel) must not resurrect the task.
      task.state = prevState;
      return task;
    }
    publishTaskEvent(taskId, {
      type: "status",
      state: task.state,
      stopReason: task.stopReason,
      summary: task.summary,
      error: task.error,
    });
    if (isTerminal(task.state)) {
      publishTaskEvent(taskId, {
        type: "result",
        result: toFullResult(task),
        versions: getBatchVersionInfo(),
      });
    }
  }
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

export function toFullResult(task: BatchTask): BatchTaskResult {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    state: task.state,
    stopReason: task.stopReason,
    finalResponse: task.finalResponse,
    usage: task.usage,
    toolCallLog: task.toolCallLog,
    artifacts: task.artifacts,
    sessionFile: task.sessionFile,
    durationMs: task.endedAt && task.startedAt ? task.endedAt - task.startedAt : undefined,
    workDir: task.actualWorkDir,
    error: task.error,
  };
}

/** Terminal states — no further transitions possible. */
export function isTerminal(state: BatchTaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
