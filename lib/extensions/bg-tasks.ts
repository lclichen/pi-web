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
 * Display needs no bridge: the browser already derives background runs (with
 * agentId + startedAt) from the Agent tool-call details in the transcript.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";

interface StopOutcome {
  ok: boolean;
  error?: string;
}

type Stopper = (agentId: string) => Promise<StopOutcome>;

declare global {
  // eslint-disable-next-line no-var
  var __piWebSubagentStop: Map<string, Stopper> | undefined;
}

const STOP_TIMEOUT_MS = 10_000;

function stoppers(): Map<string, Stopper> {
  if (!globalThis.__piWebSubagentStop) {
    globalThis.__piWebSubagentStop = new Map();
  }
  return globalThis.__piWebSubagentStop;
}

/** RPC-layer entry: forward a stop request into the session's event bus. */
export async function stopSubagentRun(sessionId: string, agentId: string): Promise<StopOutcome> {
  const stopper = stoppers().get(sessionId);
  if (!stopper) return { ok: false, error: "会话没有可用的子智能体停止通道（扩展未加载）" };
  return stopper(agentId);
}

export function makeBgTasksExtension(): InlineExtension {
  return (pi: ExtensionAPI): void => {
    const register = (sessionId: string) => {
      const bus = pi.events;
      if (!bus?.emit || !bus?.on) return;
      stoppers().set(sessionId, async (agentId: string) => {
        const requestId = randomUUID();
        return new Promise<StopOutcome>((resolve) => {
          let unsub: (() => void) | undefined;
          const timer = setTimeout(() => {
            unsub?.();
            resolve({ ok: false, error: "停止请求超时（子智能体可能已结束）" });
          }, STOP_TIMEOUT_MS);
          unsub = bus.on(`subagents:rpc:stop:reply:${requestId}`, (raw) => {
            clearTimeout(timer);
            unsub?.();
            const reply = raw as { success?: boolean; error?: string };
            resolve(reply?.success ? { ok: true } : { ok: false, error: reply?.error ?? "停止失败" });
          });
          bus.emit("subagents:rpc:stop", { agentId, requestId });
        });
      });
    };

    pi.on("session_start", async (_event, ctx) => {
      register(ctx.sessionManager.getSessionId());
    });
    pi.on("session_shutdown", async () => {
      // The map is best-effort; stale entries are overwritten on next start.
    });
  };
}
