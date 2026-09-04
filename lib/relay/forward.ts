import type { RpcMethod, RpcRequest } from "./protocol";
import { getAgent, getAgentForUser, type AgentConn } from "./registry";

// Forwards browser-originated JSON-RPC calls to the connected agent over its
// WebSocket, correlating each request id with a pending promise. Used by the
// /api/agent-relay/rpc and /rpc/stream routes. `opts.machineId` targets one of
// the user's paired machines (absent = their default/most recent machine).

const RPC_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 2 * 60 * 1000;

export class AgentUnavailableError extends Error {
  constructor(machineLabel = "") {
    super(machineLabel ? `Machine offline: ${machineLabel}` : "No local agent connected");
    this.name = "AgentUnavailableError";
  }
}

export interface ForwardOpts {
  userId?: number;
  /** Specific paired machine (multi-machine); omit for the user's default. */
  machineId?: string;
}

/** One-shot request → resolves with `result`, rejects on error/timeout/offline. */
export function relayRpc(
  method: RpcMethod,
  params?: Record<string, unknown>,
  opts?: ForwardOpts,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const agent = getReadyAgent(opts);
    if (!agent) {
      reject(agentUnavailable(opts));
      return;
    }
    const id = agent.nextId++;
    const timer = setTimeout(() => {
      agent.pending.delete(id);
      reject(new Error(`agent rpc timed out after ${RPC_TIMEOUT_MS}ms: ${method}`));
    }, RPC_TIMEOUT_MS);
    agent.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    sendRequest(agent, { id, method, params });
  });
}

/**
 * Streaming request → invokes `onChunk` for each streamed frame and resolves
 * with the terminal `result`. Used by long-running methods (exec.stream,
 * pty.*, search.grep streaming).
 */
export function relayStream(
  method: RpcMethod,
  params: Record<string, unknown> | undefined,
  onChunk: (data: unknown) => void,
  opts?: ForwardOpts,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const agent = getReadyAgent(opts);
    if (!agent) {
      reject(agentUnavailable(opts));
      return;
    }
    const id = agent.nextId++;
    const timer = setTimeout(() => {
      agent.pending.delete(id);
      reject(new Error(`agent stream timed out after ${STREAM_TIMEOUT_MS}ms: ${method}`));
    }, STREAM_TIMEOUT_MS);
    agent.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      onChunk,
    });
    sendRequest(agent, { id, method, params });
  });
}

function agentUnavailable(opts: ForwardOpts | undefined): AgentUnavailableError {
  return new AgentUnavailableError(opts?.machineId ?? "");
}

function getReadyAgent(opts?: ForwardOpts): AgentConn | null {
  const agent =
    opts?.userId === undefined && !opts?.machineId
      ? getAgent()
      : getAgentForUser(opts?.userId ?? 0, opts?.machineId);
  // info is set once the agent's hello frame arrives; treat pre-hello as offline
  if (!agent || !agent.info) return null;
  return agent;
}

function sendRequest(agent: AgentConn, req: RpcRequest): void {
  if (agent.ws.readyState !== agent.ws.OPEN) {
    throw new AgentUnavailableError();
  }
  agent.ws.send(JSON.stringify(req));
}
