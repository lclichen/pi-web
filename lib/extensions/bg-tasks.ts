/**
 * Background-task stop bridge (capsule 后台任务).
 *
 * The @tintinweb/pi-subagents package exposes a stop RPC on the per-session
 * extension event bus (`subagents:rpc:stop` → `…:reply:<requestId>`), but that
 * bus only exists inside the session process. This extension registers a
 * sessionId-keyed stopper into a globalThis map so pi-web's RPC layer can
 * forward browser stop requests (`stop_subagent`) onto the bus — the package
 * then aborts the run and its parent tool call is notified normally.
 *
 * The main Stop button also stops the session's subagents. The package treats
 * Esc as "stop the turn, leave detached agents running" (stop those from
 * /agents), which in the WebUI reads as a dead Stop button: a user who stops
 * the run expects the agents it spawned to stop too. The stopper therefore
 * tracks the ids the package announces on `subagents:started` /
 * `subagents:created` and replays stop requests for all of them on Stop.
 * Lifecycle events are top-level only, so nested children and workflow agents
 * are left to their owner, which unwinds them when the top-level run aborts.
 *
 * Display needs no bridge: the browser already derives background runs (with
 * agentId + startedAt) from the Agent tool-call details in the transcript.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";

interface StopOutcome {
  ok: boolean;
  error?: string;
  /** stopAll only: how many runs this call aborted. */
  stopped?: number;
}

interface SessionStopper {
  stop: (agentId: string) => Promise<StopOutcome>;
  stopAll: () => StopOutcome;
}

interface EventBusLike {
  on: (event: string, handler: (data: unknown) => void) => () => void;
  emit: (event: string, data: unknown) => void;
}

declare global {
  var __piWebSubagentStop: Map<string, SessionStopper> | undefined;
}

const STOP_TIMEOUT_MS = 10_000;

function stoppers(): Map<string, SessionStopper> {
  if (!globalThis.__piWebSubagentStop) {
    globalThis.__piWebSubagentStop = new Map();
  }
  return globalThis.__piWebSubagentStop;
}

/** RPC-layer entry: forward a stop request into the session's event bus. */
export async function stopSubagentRun(sessionId: string, agentId: string): Promise<StopOutcome> {
  const stopper = stoppers().get(sessionId);
  if (!stopper) return { ok: false, error: "会话没有可用的子智能体停止通道（扩展未加载）" };
  return stopper.stop(agentId);
}

/** RPC-layer entry: stop every top-level subagent this session started. */
export async function stopSessionSubagents(sessionId: string): Promise<StopOutcome> {
  const stopper = stoppers().get(sessionId);
  if (!stopper) return { ok: false, error: "会话没有可用的子智能体停止通道（扩展未加载）" };
  return stopper.stopAll();
}

/**
 * Build the per-session stopper. Exported for tests: the tracking contract is
 * "remember started/created ids, forget settled ones, replay stop on demand",
 * and it must survive the package not being loaded at all (no events → no-op).
 */
export function createSessionStopper(bus: EventBusLike): SessionStopper {
  const running = new Set<string>();

  const remember = (raw: unknown) => {
    const id = (raw as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string" && id) running.add(id);
  };
  const forget = (raw: unknown) => {
    const id = (raw as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string") running.delete(id);
  };
  bus.on("subagents:started", remember);
  // Background spawns and detached resumes announce before the run starts;
  // tracking `created` is what lets Stop also cancel queued agents.
  bus.on("subagents:created", remember);
  bus.on("subagents:completed", forget);
  bus.on("subagents:failed", forget);

  const requestStop = (agentId: string) => {
    bus.emit("subagents:rpc:stop", { agentId, requestId: randomUUID() });
  };

  return {
    stop: async (agentId: string) => {
      const requestId = randomUUID();
      return new Promise<StopOutcome>((resolve) => {
        // Object holder: the timeout and the reply handler each need the
        // other's handle, and both are declared before either is assigned.
        const state: { unsub?: () => void } = {};
        const timer = setTimeout(() => {
          state.unsub?.();
          resolve({ ok: false, error: "停止请求超时（子智能体可能已结束）" });
        }, STOP_TIMEOUT_MS);
        state.unsub = bus.on(`subagents:rpc:stop:reply:${requestId}`, (raw) => {
          clearTimeout(timer);
          state.unsub?.();
          const reply = raw as { success?: boolean; error?: string };
          resolve(reply?.success ? { ok: true } : { ok: false, error: reply?.error ?? "停止失败" });
        });
        bus.emit("subagents:rpc:stop", { agentId, requestId });
      });
    },
    stopAll: () => {
      const ids = [...running];
      running.clear();
      // Fire-and-forget: the package's abort() is synchronous, and the caller
      // (Stop) must not wait on one agent's reply before aborting the parent.
      for (const agentId of ids) requestStop(agentId);
      return { ok: true, stopped: ids.length };
    },
  };
}

export function makeBgTasksExtension(): InlineExtension {
  return (pi: ExtensionAPI): void => {
    const register = (sessionId: string) => {
      const bus = pi.events;
      if (!bus?.emit || !bus?.on) return;
      stoppers().set(sessionId, createSessionStopper(bus));
    };

    pi.on("session_start", async (_event, ctx) => {
      // Defensive: some embedded hosts construct a trimmed ExtensionContext
      // (e.g. the MCP adapter's load-time partial ctx). A missing session
      // manager previously surfaced as "Cannot read properties of undefined
      // (reading 'getSessionId')" from a foreign init path.
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (sessionId) register(sessionId);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      if (sessionId) stoppers().delete(sessionId);
    });
  };
}
