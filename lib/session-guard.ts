import { getHeapStatistics } from "node:v8";

/**
 * Session governance knobs (dev 批次4): admission caps for interactive session
 * creation and the heap-pressure eviction guard. Pure configuration math —
 * rpc-manager owns the registry wiring.
 *
 * Sizing notes (target 50 users × 2 concurrent sessions on a ~40G server):
 * - per-user default 8 gives 4× headroom over the 2-session working set;
 * - global default 400 holds the whole org with room for multi-tab sessions;
 * - the heap guard defaults to 70% of the V8 heap limit, so raising
 *   NODE_OPTIONS=--max-old-space-size on a bigger box moves the guard with it.
 */

const DEFAULT_MAX_SESSIONS_PER_USER = 8;
const DEFAULT_MAX_LIVE_SESSIONS = 400;

function envUint(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** Max live sessions for one non-admin user. 0 = unlimited. */
export function maxSessionsPerUser(): number {
  return envUint("PI_WEB_MAX_SESSIONS_PER_USER", DEFAULT_MAX_SESSIONS_PER_USER);
}

/** Max live sessions across all users. 0 = unlimited. */
export function maxLiveSessions(): number {
  return envUint("PI_WEB_MAX_LIVE_SESSIONS", DEFAULT_MAX_LIVE_SESSIONS);
}

export interface QuotaContext {
  userId: number;
  role: "admin" | "user";
  /** Live sessions this user owns right now (before this request). */
  perUserLive: number;
  /** Live sessions across all users right now (before this request). */
  globalLive: number;
}

export interface QuotaRejection {
  status: 429;
  error: string;
}

/**
 * Admission decision for POST /api/agent/new. Admins are exempt from the
 * per-user cap (they legitimately hold host-space support sessions) but not
 * from the global cap — that one exists to keep the process inside its heap.
 */
export function checkSessionQuota(context: QuotaContext): QuotaRejection | null {
  const globalCap = maxLiveSessions();
  if (globalCap > 0 && context.globalLive >= globalCap) {
    return {
      status: 429,
      error: `Server is at its live session limit (${globalCap}). Close idle sessions or ask an administrator to raise PI_WEB_MAX_LIVE_SESSIONS.`,
    };
  }
  const perUserCap = maxSessionsPerUser();
  if (context.role !== "admin" && perUserCap > 0 && context.perUserLive >= perUserCap) {
    return {
      status: 429,
      error: `You have ${perUserCap} live sessions, the per-user limit. Close one before starting another.`,
    };
  }
  return null;
}

const DEFAULT_HEAP_GUARD_FRACTION = 0.7;

/**
 * Heap-used threshold above which idle sessions get evicted.
 * `PI_WEB_SESSION_HEAP_GUARD_MB` in MiB (0 disables); default is
 * DEFAULT_HEAP_GUARD_FRACTION of the V8 heap limit, which tracks
 * --max-old-space-size automatically on bigger hardware.
 */
export function heapGuardLimitBytes(): number {
  const rawMb = Number(process.env.PI_WEB_SESSION_HEAP_GUARD_MB);
  if (Number.isFinite(rawMb)) {
    return rawMb > 0 ? Math.floor(rawMb) * 1024 * 1024 : 0;
  }
  try {
    const limit = getHeapStatistics().heap_size_limit;
    return limit > 0 ? Math.floor(limit * DEFAULT_HEAP_GUARD_FRACTION) : 0;
  } catch {
    return 0;
  }
}

/** Evict down to this fraction of the limit (hysteresis against flapping). */
export const HEAP_GUARD_TARGET_FRACTION = 0.9;

/** Max sessions one sweep may evict: freeing is visible only after GC, so a
 * sweep must not chase a stale reading through the whole registry. */
export const HEAP_GUARD_MAX_EVICTIONS_PER_SWEEP = 8;

export interface EvictableSession {
  sessionId: string;
  /** ms epoch of the last command, falling back to creation time. */
  lastActiveAt: number;
}

export interface MemoryGuardIO {
  heapUsedBytes(): number;
  /** Threshold from heapGuardLimitBytes(). 0 disables the guard. */
  limitBytes: number;
  /** Shutdown hook (rpc-manager's wrapper.shutdown). */
  shutdown(sessionId: string): Promise<void>;
  /** Called per eviction for logging/debug. */
  onEvict?(session: EvictableSession, heapUsedBytes: number): void;
}

/**
 * Evict least-recently-active idle sessions while heap usage stays above the
 * limit's target band. Returns the evicted session ids (possibly empty —
 * pressure with only running sessions is left to the next sweep or the
 * operator; killing an active turn is never this guard's call).
 */
export async function evictIdleSessionsUnderPressure(
  candidates: EvictableSession[],
  io: MemoryGuardIO,
  maxEvictions = HEAP_GUARD_MAX_EVICTIONS_PER_SWEEP,
): Promise<string[]> {
  if (io.limitBytes <= 0) return [];
  const target = io.limitBytes * HEAP_GUARD_TARGET_FRACTION;
  const evicted: string[] = [];
  const sorted = [...candidates].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const candidate of sorted) {
    if (io.heapUsedBytes() <= target || evicted.length >= maxEvictions) break;
    try {
      await io.shutdown(candidate.sessionId);
      evicted.push(candidate.sessionId);
      io.onEvict?.(candidate, io.heapUsedBytes());
    } catch {
      // One wedged shutdown must not stop the sweep from trying others.
    }
  }
  return evicted;
}
