import type { WebSocket } from "ws";
import type {
  AgentHello,
  AgentInfo,
  AgentToRelayMessage,
  PairingCode,
  RelayStatus,
} from "./protocol";
import { generatePairingCode, normalizeCode, PAIRING_TTL_MS } from "./pairing";
import { isKnownToken } from "./relay-store";

// In-memory relay state, stored on globalThis so it survives Next.js
// hot-reload (same pattern as __piSessions in lib/rpc-manager.ts). MVP holds a
// single connected agent slot; Phase 3 generalizes to multiple devices.

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onChunk?: (data: unknown) => void;
}

export interface AgentConn {
  ws: WebSocket;
  info: AgentInfo | null;
  connectedAt: number;
  pending: Map<number, PendingRequest>;
  nextId: number;
}

interface RelayRegistry {
  pairCodes: Map<string, PairingCode>;
  agent: AgentConn | null;
  statusSubscribers: Set<(status: RelayStatus) => void>;
  // PTY output subscribers, keyed by agent-side session id. The agent pushes
  // unsolicited pty.output "event" frames; these fan out to the SSE streams.
  ptySubscribers: Map<string, Set<(data: string) => void>>;
}

declare global {
  var __piRelayRegistry: RelayRegistry | undefined;
}

function newRegistry(): RelayRegistry {
  return {
    pairCodes: new Map(),
    agent: null,
    statusSubscribers: new Set(),
    ptySubscribers: new Map(),
  };
}

export function getRegistry(): RelayRegistry {
  if (!globalThis.__piRelayRegistry) {
    globalThis.__piRelayRegistry = newRegistry();
  }
  return globalThis.__piRelayRegistry;
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

export function createPairingCode(): PairingCode {
  const reg = getRegistry();
  const now = Date.now();
  // sweep expired/consumed codes so the map can't grow unbounded
  for (const [key, value] of reg.pairCodes) {
    if (value.consumed || value.expiresAt <= now) reg.pairCodes.delete(key);
  }
  const code = generatePairingCode();
  const pc: PairingCode = { code, createdAt: now, expiresAt: now + PAIRING_TTL_MS, consumed: false };
  reg.pairCodes.set(code, pc);
  return pc;
}

/** Validate + atomically consume a pairing code. Returns false if invalid/expired. */
export function consumePairingCode(rawCode: string): boolean {
  const reg = getRegistry();
  const code = normalizeCode(rawCode);
  const pc = reg.pairCodes.get(code);
  const now = Date.now();
  if (!pc || pc.consumed || pc.expiresAt <= now) {
    if (pc) reg.pairCodes.delete(code);
    return false;
  }
  pc.consumed = true;
  reg.pairCodes.delete(code);
  return true;
}

// ---------------------------------------------------------------------------
// Agent connection
// ---------------------------------------------------------------------------

export function isKnownAgentToken(token: string): boolean {
  return isKnownToken(token);
}

export function getAgent(): AgentConn | null {
  return getRegistry().agent;
}

/**
 * Wire a freshly-upgraded WebSocket into the registry. The agent must send an
 * initial `{type:"hello", info}` frame; until then `getAgent()` reports the
 * connection as not-yet-ready. All subsequent frames are RPC responses/chunks
 * dispatched by request id to the matching pending promise.
 */
export function attachAgentSocket(ws: WebSocket): void {
  const reg = getRegistry();

  // Single-slot MVP: evict any prior agent.
  if (reg.agent) {
    const prev = reg.agent;
    reg.agent = null;
    rejectAllPending(prev, new Error("agent replaced by a newer connection"));
    try {
      prev.ws.close();
    } catch {
      // ignore
    }
  }

  const conn: AgentConn = {
    ws,
    info: null,
    connectedAt: Date.now(),
    pending: new Map(),
    nextId: 1,
  };

  const onMessage = (raw: unknown): void => {
    let msg: AgentToRelayMessage;
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      msg = JSON.parse(text) as AgentToRelayMessage;
    } catch {
      return; // ignore malformed frames
    }

    if ((msg as { type?: string }).type === "hello") {
      conn.info = (msg as AgentHello).info;
      if (reg.agent !== conn) reg.agent = conn;
      notifyStatus();
      return;
    }

    // Unsolicited agent-pushed event (e.g. pty.output) — no request id.
    if ((msg as { type?: string }).type === "event") {
      const event = (msg as { event?: string }).event;
      if (event === "pty.output") {
        const sessionId = (msg as { sessionId?: string }).sessionId;
        const data = (msg as { data?: string }).data;
        if (typeof sessionId === "string" && typeof data === "string") {
          notifyPtyOutput(sessionId, data);
        }
      }
      return;
    }

    const id = (msg as { id?: number }).id;
    if (typeof id !== "number") return;
    const pending = conn.pending.get(id);
    if (!pending) return;

    const type = (msg as { type?: string }).type;
    if (type === "chunk") {
      pending.onChunk?.((msg as { data?: unknown }).data);
      return;
    }
    // one-shot RpcResponse or terminal RpcEnd
    clearTimeout(pending.timer);
    conn.pending.delete(id);
    const ok = (msg as { ok?: boolean }).ok;
    if (ok) {
      pending.resolve((msg as { result?: unknown }).result);
    } else {
      pending.reject(new Error((msg as { error?: string }).error ?? "agent rpc failed"));
    }
  };

  const cleanup = (): void => {
    ws.off("message", onMessage);
    rejectAllPending(conn, new Error("agent disconnected"));
    if (reg.agent === conn) {
      reg.agent = null;
      notifyStatus();
    }
  };

  ws.on("message", onMessage);
  ws.once("close", cleanup);
  ws.once("error", cleanup);

  // If the agent never sends hello within a grace window, drop the socket.
  const helloTimer = setTimeout(() => {
    if (!conn.info) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }, 10_000);
  ws.once("close", () => clearTimeout(helloTimer));
}

function rejectAllPending(conn: AgentConn, err: Error): void {
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  conn.pending.clear();
}

// ---------------------------------------------------------------------------
// Status pub/sub
// ---------------------------------------------------------------------------

export function getStatus(): RelayStatus {
  const agent = getRegistry().agent;
  return agent?.info ? { online: true, info: agent.info } : { online: false };
}

export function subscribeStatus(cb: (status: RelayStatus) => void): () => void {
  const reg = getRegistry();
  reg.statusSubscribers.add(cb);
  return () => {
    reg.statusSubscribers.delete(cb);
  };
}

function notifyStatus(): void {
  const status = getStatus();
  for (const cb of getRegistry().statusSubscribers) {
    try {
      cb(status);
    } catch {
      // ignore subscriber errors
    }
  }
}

// --- PTY output pub/sub (web terminal) ---

export function subscribePtyOutput(
  sessionId: string,
  cb: (data: string) => void,
): () => void {
  const reg = getRegistry();
  let set = reg.ptySubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    reg.ptySubscribers.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    const s = reg.ptySubscribers.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) reg.ptySubscribers.delete(sessionId);
  };
}

function notifyPtyOutput(sessionId: string, data: string): void {
  const set = getRegistry().ptySubscribers.get(sessionId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(data);
    } catch {
      // ignore subscriber errors
    }
  }
}
