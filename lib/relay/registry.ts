import type { WebSocket } from "ws";
import type {
  AgentHello,
  AgentInfo,
  AgentToRelayMessage,
  MachineStatus,
  PairingCode,
  RelayStatus,
} from "./protocol";
import { generatePairingCode, normalizeCode, PAIRING_TTL_MS } from "./pairing";
import { isKnownToken, listAgentTokens } from "./relay-store";

// In-memory relay state, stored on globalThis so it survives Next.js
// hot-reload (same pattern as __piSessions in lib/rpc-manager.ts).
//
// Multi-machine (2026-09): one user may pair SEVERAL machines; the registry
// holds a live connection per (userId, machineId). A reconnect of the SAME
// machine evicts only that machine's previous connection. The legacy single
// `agent` slot remains the auth-off / userId-0 view and points at the most
// recent connection overall.

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
  /** Owning web user id (0 = unbound/auth-off). */
  ownerUserId: number;
  /** Stable machine identity ("default" for pre-machineId agents). */
  machineId: string;
  /** Monotonic attach sequence — the default-machine tie-breaker (clock
   *  resolution is not enough when two machines connect in the same ms). */
  seq: number;
}

/** Machine id used when an agent predates machine identity. */
export const DEFAULT_MACHINE_ID = "default";

export interface StatusUpdate {
  userId: number;
  status: RelayStatus;
}

interface RelayRegistry {
  pairCodes: Map<string, PairingCode>;
  /** Latest connection (single-slot compat; see agentsByUser). */
  agent: AgentConn | null;
  /** Multi-slot: live agents per (user, machine). */
  agentsByUser: Map<number, Map<string, AgentConn>>;
  statusSubscribers: Set<(update: StatusUpdate) => void>;
  // PTY output subscribers, keyed `${machineId}:${agentSid}`. The agent pushes
  // unsolicited pty.output "event" frames; these fan out to the SSE streams.
  ptySubscribers: Map<string, Set<(data: string) => void>>;
  /** PTY exit subscribers, same keying as ptySubscribers. */
  ptyExitSubscribers: Map<string, Set<(code: number) => void>>;
  /** agent-side pty session id → web user that created it (ownership gate). */
  ptyOwners: Map<string, number>;
  /** agent-side pty session id → machine that hosts it (routing key). */
  ptySids: Map<string, string>;
}

declare global {
  var __piRelayRegistry: RelayRegistry | undefined;
  var __piRelayAttachSeq: number | undefined;
}

function nextAttachSeq(): number {
  globalThis.__piRelayAttachSeq = (globalThis.__piRelayAttachSeq ?? 0) + 1;
  return globalThis.__piRelayAttachSeq;
}

function newRegistry(): RelayRegistry {
  return {
    pairCodes: new Map(),
    agent: null,
    agentsByUser: new Map(),
    statusSubscribers: new Set(),
    ptySubscribers: new Map(),
    ptyExitSubscribers: new Map(),
    ptyOwners: new Map(),
    ptySids: new Map(),
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

export function createPairingCode(ownerUserId = 0, label?: string): PairingCode {
  const reg = getRegistry();
  const now = Date.now();
  // sweep expired/consumed codes so the map can't grow unbounded
  for (const [key, value] of reg.pairCodes) {
    if (value.consumed || value.expiresAt <= now) reg.pairCodes.delete(key);
  }
  const code = generatePairingCode();
  const pc: PairingCode = {
    ownerUserId,
    code,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    consumed: false,
    ...(label ? { label } : {}),
  };
  reg.pairCodes.set(code, pc);
  return pc;
}

/** Validate + atomically consume a pairing code. Returns the owning user id
 *  and optional pre-chosen label, or null if invalid/expired. */
export function consumePairingCode(rawCode: string): { userId: number; label?: string } | null {
  const reg = getRegistry();
  const code = normalizeCode(rawCode);
  const pc = reg.pairCodes.get(code);
  const now = Date.now();
  if (!pc || pc.consumed || pc.expiresAt <= now) {
    if (pc) reg.pairCodes.delete(code);
    return null;
  }
  pc.consumed = true;
  reg.pairCodes.delete(code);
  return { userId: pc.ownerUserId, ...(pc.label ? { label: pc.label } : {}) };
}

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

export function isKnownAgentToken(token: string): boolean {
  return isKnownToken(token);
}

export function getAgent(): AgentConn | null {
  return getRegistry().agent;
}

/**
 * The agent bound to a web user. `machineId` selects a specific machine;
 * without it the user's MOST RECENT connection wins (single-machine
 * behavior). userId 0 / unknown falls back to the global slot (auth-off).
 */
export function getAgentForUser(userId: number, machineId?: string): AgentConn | null {
  const reg = getRegistry();
  if (machineId) {
    const byMachine = reg.agentsByUser.get(userId);
    const conn = byMachine?.get(machineId);
    if (conn) return conn;
    if (userId !== 0) return null; // explicit machine requested but offline
  }
  if (userId === 0) return reg.agent;
  const byMachine = reg.agentsByUser.get(userId);
  if (!byMachine || byMachine.size === 0) return null;
  let newest: AgentConn | null = null;
  for (const conn of byMachine.values()) {
    if (!newest || conn.seq > newest.seq) newest = conn;
  }
  return newest;
}

/** machineId of the user's default (most recent) agent, for keying PTYs. */
export function defaultMachineForUser(userId: number): string {
  return getAgentForUser(userId)?.machineId ?? DEFAULT_MACHINE_ID;
}

/**
 * Wire a freshly-upgraded WebSocket into the registry. The agent must send an
 * initial `{type:"hello", info}` frame; until then the connection carries
 * placeholder info (older agents never send hello — keep them usable).
 */
export function attachAgentSocket(ws: WebSocket, ownerUserId = 0, machineId = DEFAULT_MACHINE_ID): void {
  const reg = getRegistry();

  // One live agent per (user, machine): evict that machine's previous
  // connection ONLY. The legacy single-slot field keeps pointing at the most
  // recent conn overall.
  const byMachine = reg.agentsByUser.get(ownerUserId) ?? new Map<string, AgentConn>();
  const prev = byMachine.get(machineId) ?? null;
  if (prev) {
    byMachine.delete(machineId);
    rejectAllPending(prev, new Error("agent replaced by a newer connection"));
    try {
      prev.ws.close();
    } catch {
      // ignore
    }
  }

  const conn: AgentConn = {
    ws,
    // hello is OPTIONAL (older agents never send it — the server used to drop
    // them after a 10s grace, reconnect-looping forever). Placeholder info
    // keeps the connection usable; a later hello upgrades it.
    info: {
      hostname: "agent",
      os: "unknown",
      arch: "unknown",
      workspaceRoot: ".",
      agentVersion: "unknown",
    },
    connectedAt: Date.now(),
    pending: new Map(),
    nextId: 1,
    ownerUserId,
    machineId,
    seq: nextAttachSeq(),
  };
  byMachine.set(machineId, conn);
  reg.agentsByUser.set(ownerUserId, byMachine);
  reg.agent = conn;

  const onMessage = (raw: unknown): void => {
    let msg: AgentToRelayMessage;
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      msg = JSON.parse(text) as AgentToRelayMessage;
    } catch {
      return; // ignore malformed frames
    }

    if ((msg as { type?: string }).type === "hello") {
      conn.info = { ...(msg as AgentHello).info };
      if (reg.agent !== conn) reg.agent = conn;
      notifyStatusFor(ownerUserId);
      return;
    }

    // Unsolicited agent-pushed event (e.g. pty.output) — no request id.
    if ((msg as { type?: string }).type === "event") {
      const event = (msg as { event?: string }).event;
      if (event === "pty.output") {
        const sessionId = (msg as { sessionId?: string }).sessionId;
        const data = (msg as { data?: string }).data;
        if (typeof sessionId === "string" && typeof data === "string") {
          notifyPtyOutput(ptyKey(conn.machineId, sessionId), data);
        }
      } else if (event === "pty.exit") {
        const sessionId = (msg as { sessionId?: string }).sessionId;
        const code = (msg as { code?: number }).code;
        if (typeof sessionId === "string") {
          notifyPtyExit(ptyKey(conn.machineId, sessionId), typeof code === "number" ? code : 0);
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
    const current = reg.agentsByUser.get(conn.ownerUserId);
    if (current?.get(conn.machineId) === conn) {
      current.delete(conn.machineId);
      if (current.size === 0) reg.agentsByUser.delete(conn.ownerUserId);
    }
    if (reg.agent === conn) {
      reg.agent = null;
    }
    notifyStatusFor(conn.ownerUserId);
  };

  ws.on("message", onMessage);
  ws.once("close", cleanup);
  ws.once("error", cleanup);
  notifyStatusFor(ownerUserId);
}

function rejectAllPending(conn: AgentConn, err: Error): void {
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  conn.pending.clear();
}

/** Force-disconnect one of the user's machines (unpair). The socket's close
 *  handler runs the normal cleanup + status notification. */
export function disconnectMachine(userId: number, machineId: string): boolean {
  const conn = getRegistry().agentsByUser.get(userId)?.get(machineId);
  if (!conn) return false;
  try {
    conn.ws.close(4001, "unpaired");
  } catch {
    // already closing
  }
  return true;
}

// ---------------------------------------------------------------------------
// Machine directory (paired machines, online or not)
// ---------------------------------------------------------------------------

/** All machines paired by a user: live connections merged with the persisted
 *  token store (offline machines keep their label + lastSeenAt). */
export function getMachinesForUser(userId: number): MachineStatus[] {
  const reg = getRegistry();
  const live = reg.agentsByUser.get(userId) ?? new Map<string, AgentConn>();
  const byId = new Map<string, MachineStatus>();
  for (const { record } of listAgentTokens()) {
    if (record.userId !== userId) continue;
    const machineId = record.machineId ?? DEFAULT_MACHINE_ID;
    byId.set(machineId, {
      machineId,
      label: record.label ?? record.hostname ?? machineId.slice(0, 8),
      online: false,
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(record.hostname ? { hostname: record.hostname } : {}),
    });
  }
  for (const [machineId, conn] of live) {
    const existing = byId.get(machineId);
    byId.set(machineId, {
      machineId,
      label: existing?.label ?? conn.info?.hostname ?? machineId.slice(0, 8),
      online: true,
      info: conn.info ?? undefined,
      ...(existing?.lastSeenAt ? { lastSeenAt: existing.lastSeenAt } : {}),
      ...(existing?.hostname ? { hostname: existing.hostname } : {}),
    });
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Status pub/sub
// ---------------------------------------------------------------------------

export function getStatus(): RelayStatus {
  const agent = getRegistry().agent;
  return agent?.info ? { online: true, info: agent.info } : { online: false };
}

/** Status snapshot for a web user: default machine compat + machines list. */
export function getStatusForUser(userId: number): RelayStatus {
  if (userId === 0) return getStatus();
  const machines = getMachinesForUser(userId);
  const agent = getAgentForUser(userId);
  if (!agent?.info) return { online: false, machines };
  return { online: true, info: agent.info, machines };
}

export function subscribeStatus(cb: (update: StatusUpdate) => void): () => void {
  const reg = getRegistry();
  reg.statusSubscribers.add(cb);
  return () => {
    reg.statusSubscribers.delete(cb);
  };
}

function notifyStatusFor(userId: number): void {
  const reg = getRegistry();
  const status = getStatusForUser(userId);
  for (const cb of reg.statusSubscribers) {
    try {
      cb({ userId, status });
    } catch {
      // ignore subscriber errors
    }
  }
}

// --- PTY output pub/sub (web terminal) ---

/** Subscriber key for a machine-scoped agent PTY session. */
export function ptyKey(machineId: string, agentSid: string): string {
  return `${machineId}:${agentSid}`;
}

/** Remember which web user created an agent-side PTY (see /terminal/create). */
export function recordPtyOwner(sessionId: string, ownerUserId: number, machineId = DEFAULT_MACHINE_ID): void {
  if (!sessionId) return;
  const reg = getRegistry();
  reg.ptyOwners.set(sessionId, ownerUserId);
  reg.ptySids.set(sessionId, machineId);
}

/** Forget a PTY ownership entry once the session is closed. */
export function dropPtyOwner(sessionId: string): void {
  const reg = getRegistry();
  reg.ptyOwners.delete(sessionId);
  reg.ptySids.delete(sessionId);
}

/** Machine hosting an agent-side PTY session (for event routing). */
export function machineForPty(sessionId: string): string {
  return getRegistry().ptySids.get(sessionId) ?? DEFAULT_MACHINE_ID;
}

/**
 * May `user` operate on the agent-side PTY `sessionId`? Host identity (id 0,
 * auth off) and admins pass; everyone else must have created the PTY. Unknown
 * sid → deny: these sids travel in URLs, so possession is not authorization.
 */
export function authorizePtySession(
  sessionId: string,
  user: { id: number; role: string },
): boolean {
  if (user.id === 0 || user.role === "admin") return true;
  const owner = getRegistry().ptyOwners.get(sessionId);
  return owner !== undefined && owner === user.id;
}

export function subscribePtyOutput(
  sessionId: string,
  cb: (data: string) => void,
  machineId = DEFAULT_MACHINE_ID,
): () => void {
  const reg = getRegistry();
  const key = ptyKey(machineId, sessionId);
  let set = reg.ptySubscribers.get(key);
  if (!set) {
    set = new Set();
    reg.ptySubscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    const s = reg.ptySubscribers.get(key);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) reg.ptySubscribers.delete(key);
  };
}

function notifyPtyOutput(key: string, data: string): void {
  const set = getRegistry().ptySubscribers.get(key);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(data);
    } catch {
      // ignore subscriber errors
    }
  }
}

/** Subscribe to the agent's pty.exit push for one machine-scoped session. */
export function subscribePtyExit(
  sessionId: string,
  cb: (code: number) => void,
  machineId = DEFAULT_MACHINE_ID,
): () => void {
  const reg = getRegistry();
  const key = ptyKey(machineId, sessionId);
  let set = reg.ptyExitSubscribers.get(key);
  if (!set) {
    set = new Set();
    reg.ptyExitSubscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    const s = reg.ptyExitSubscribers.get(key);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) reg.ptyExitSubscribers.delete(key);
  };
}

function notifyPtyExit(key: string, code: number): void {
  const set = getRegistry().ptyExitSubscribers.get(key);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(code);
    } catch {
      // ignore subscriber errors
    }
  }
}
