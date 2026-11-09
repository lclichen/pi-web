import { dirname, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionPathKey } from "./session-path.ts";
import { perfStats, recordSessionOpen } from "./perf-stats.ts";
import { logServerEvent } from "./server-log.ts";

/**
 * Session-file opening for pi-web (dev 批次3), combining two layers:
 *
 * 1. A read-only SessionManager LRU cache (upstream design, session-reader
 *    main:476-594): detail/history/pagination routes re-open the same file on
 *    every request when no live wrapper exists — a fingerprint-validated cache
 *    turns repeat opens into ~1ms map hits. Budget: entries are also capped by
 *    summed on-disk size, and one oversize session is served fresh instead of
 *    evicting everything else.
 *
 * 2. A worker-thread parser for large files (ours — upstream has no workers).
 *    SDK `loadEntriesFromFile` is fully synchronous (openSync + readSync +
 *    per-line JSON.parse): a 20MB transcript stalls the shared event loop
 *    75-150ms, and 50 users opening pages in one login wave queues those
 *    stalls back to back — the "frontend inaccessible" freeze. The worker
 *    parses off-loop and hands the entries back through the SDK constructor's
 *    `preloadedFileEntries` injection (session-manager.js:598/619-622), so the
 *    main thread only pays the O(n) index build. Files below
 *    PI_WEB_PARSE_WORKER_MIN_BYTES open synchronously (the stall is cheaper
 *    than a round-trip); worker failure or timeout falls back to the
 *    synchronous open, preserving SDK semantics.
 *
 * `mutable: true` (live wrappers, appends, branching) always opens fresh and
 * never shares a cached manager.
 */

// The .d.ts marks the constructor private, but the runtime constructor accepts
// preloaded entries by design (used by static open's header-scan-limit path).
type SessionManagerWithPreload = new (
  cwd: string,
  sessionDir: string,
  sessionFile: string,
  persist: boolean,
  newSessionOptions?: undefined,
  preloadedFileEntries?: unknown[],
) => SessionManager;
const SessionManagerCtor = SessionManager as unknown as SessionManagerWithPreload;

// ---------------------------------------------------------------------------
// Read-only LRU cache.
// ---------------------------------------------------------------------------

interface SmCacheEntry {
  sm: SessionManager;
  fingerprint: string;
  /** On-disk size, the proxy for this entry's retained heap. */
  bytes: number;
}

declare global {
   
  var __piWebSmCache: Map<string, SmCacheEntry> | undefined;
}

/** Cache budget. Exported so tests can shrink it to on-disk-producible values. */
export const SM_CACHE_LIMITS = {
  /** Most sessions held at once. */
  maxEntries: 12,
  /** Summed on-disk size of cached sessions. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** A session larger than this is never cached — it would evict everything else. */
  maxFileBytes: 64 * 1024 * 1024,
};

function getSmCache(): Map<string, SmCacheEntry> {
  if (!globalThis.__piWebSmCache) globalThis.__piWebSmCache = new Map();
  return globalThis.__piWebSmCache;
}

function sessionFileStats(filePath: string): { fingerprint: string; bytes: number } | null {
  try {
    const stats = statSync(filePath);
    return { fingerprint: `${stats.size}:${stats.mtimeMs}`, bytes: stats.size };
  } catch {
    return null;
  }
}

/** Evict least-recently-used entries until both the count and byte caps hold. */
function evictSmCache(cache: Map<string, SmCacheEntry>): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > SM_CACHE_LIMITS.maxEntries || total > SM_CACHE_LIMITS.maxTotalBytes) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    total -= cache.get(oldestKey)?.bytes ?? 0;
    cache.delete(oldestKey);
  }
}

export function invalidateSessionManagerCache(filePath?: string): void {
  const cache = getSmCache();
  if (filePath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(sessionPathKey(filePath));
}

// ---------------------------------------------------------------------------
// Worker-thread parser pool.
// ---------------------------------------------------------------------------

// The worker source is stored base64-encoded and decoded at runtime: an
// inline template literal containing ESM `import` statements deadlocks
// jiti's transform (the test loader) and invites bundler parsing. Node 22
// treats eval'd worker code as an ES module, so the source uses ESM
// imports against node: builtins only. Decoded it parses session JSONL
// with the SDK loadEntriesFromFile semantics (blank/malformed lines
// skipped, first entry must be a session header).
const WORKER_SOURCE = Buffer.from(
  "aW1wb3J0IHsgcGFyZW50UG9ydCB9IGZyb20gIm5vZGU6d29ya2VyX3RocmVhZHMiOwppbXBvcnQgeyBvcGVuU3luYywgcmVhZFN5bmMsIGNsb3NlU3luYyB9IGZyb20gIm5vZGU6ZnMiOwppbXBvcnQgeyBTdHJpbmdEZWNvZGVyIH0gZnJvbSAibm9kZTpzdHJpbmdfZGVjb2RlciI7CmZ1bmN0aW9uIHBhcnNlTGluZShsaW5lKSB7CiAgaWYgKCFsaW5lLnRyaW0oKSkgcmV0dXJuIG51bGw7CiAgdHJ5IHsKICAgIGNvbnN0IGVudHJ5ID0gSlNPTi5wYXJzZShsaW5lKTsKICAgIHJldHVybiBlbnRyeSAmJiB0eXBlb2YgZW50cnkgPT09ICJvYmplY3QiID8gZW50cnkgOiBudWxsOwogIH0gY2F0Y2ggewogICAgcmV0dXJuIG51bGw7CiAgfQp9CnBhcmVudFBvcnQub24oIm1lc3NhZ2UiLCAoam9iKSA9PiB7CiAgdHJ5IHsKICAgIGNvbnN0IGVudHJpZXMgPSBbXTsKICAgIGxldCBwZW5kaW5nID0gIiI7CiAgICBjb25zdCBmZCA9IG9wZW5TeW5jKGpvYi5maWxlUGF0aCwgInIiKTsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcigidXRmOCIpOwogICAgICBjb25zdCBidWZmZXIgPSBCdWZmZXIuYWxsb2NVbnNhZmUoMTAyNCAqIDEwMjQpOwogICAgICBjb25zdCBOTCA9ICJcbiI7CiAgICAgIHdoaWxlICh0cnVlKSB7CiAgICAgICAgY29uc3QgYnl0ZXNSZWFkID0gcmVhZFN5bmMoZmQsIGJ1ZmZlciwgMCwgYnVmZmVyLmxlbmd0aCwgbnVsbCk7CiAgICAgICAgaWYgKGJ5dGVzUmVhZCA9PT0gMCkgYnJlYWs7CiAgICAgICAgcGVuZGluZyArPSBkZWNvZGVyLndyaXRlKGJ1ZmZlci5zdWJhcnJheSgwLCBieXRlc1JlYWQpKTsKICAgICAgICBsZXQgbGluZVN0YXJ0ID0gMDsKICAgICAgICBsZXQgbmV3bGluZUluZGV4ID0gcGVuZGluZy5pbmRleE9mKE5MLCBsaW5lU3RhcnQpOwogICAgICAgIHdoaWxlIChuZXdsaW5lSW5kZXggIT09IC0xKSB7CiAgICAgICAgICBjb25zdCBlbnRyeSA9IHBhcnNlTGluZShwZW5kaW5nLnNsaWNlKGxpbmVTdGFydCwgbmV3bGluZUluZGV4KSk7CiAgICAgICAgICBpZiAoZW50cnkpIGVudHJpZXMucHVzaChlbnRyeSk7CiAgICAgICAgICBsaW5lU3RhcnQgPSBuZXdsaW5lSW5kZXggKyAxOwogICAgICAgICAgbmV3bGluZUluZGV4ID0gcGVuZGluZy5pbmRleE9mKE5MLCBsaW5lU3RhcnQpOwogICAgICAgIH0KICAgICAgICBwZW5kaW5nID0gcGVuZGluZy5zbGljZShsaW5lU3RhcnQpOwogICAgICB9CiAgICAgIHBlbmRpbmcgKz0gZGVjb2Rlci5lbmQoKTsKICAgICAgY29uc3QgZmluYWxFbnRyeSA9IHBhcnNlTGluZShwZW5kaW5nKTsKICAgICAgaWYgKGZpbmFsRW50cnkpIGVudHJpZXMucHVzaChmaW5hbEVudHJ5KTsKICAgIH0gZmluYWxseSB7CiAgICAgIGNsb3NlU3luYyhmZCk7CiAgICB9CiAgICBjb25zdCBoZWFkZXIgPSBlbnRyaWVzWzBdOwogICAgaWYgKCFoZWFkZXIgfHwgaGVhZGVyLnR5cGUgIT09ICJzZXNzaW9uIiB8fCB0eXBlb2YgaGVhZGVyLmlkICE9PSAic3RyaW5nIikgewogICAgICBwYXJlbnRQb3J0LnBvc3RNZXNzYWdlKHsgaWQ6IGpvYi5pZCwgb2s6IGZhbHNlLCBlcnJvcjogIm5vdCBhIHZhbGlkIHBpIHNlc3Npb24gZmlsZSIgfSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIHBhcmVudFBvcnQucG9zdE1lc3NhZ2UoeyBpZDogam9iLmlkLCBvazogdHJ1ZSwgZW50cmllcyB9KTsKICB9IGNhdGNoIChlcnJvcikgewogICAgcGFyZW50UG9ydC5wb3N0TWVzc2FnZSh7IGlkOiBqb2IuaWQsIG9rOiBmYWxzZSwgZXJyb3I6IFN0cmluZygoZXJyb3IgJiYgZXJyb3IubWVzc2FnZSkgfHwgZXJyb3IpIH0pOwogIH0KfSk7Cg==",
  "base64",
).toString("utf8");

function envInt(name: string, fallback: number, min = 0): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

function parseWorkerCount(): number {
  return envInt("PI_WEB_PARSE_WORKERS", 2);
}

function parseWorkerMinBytes(): number {
  return envInt("PI_WEB_PARSE_WORKER_MIN_BYTES", 2 * 1024 * 1024);
}

function parseTimeoutMs(): number {
  return envInt("PI_WEB_PARSE_TIMEOUT_MS", 30_000, 1_000);
}

function parseIdleReapMs(): number {
  return envInt("PI_WEB_PARSE_IDLE_REAP_MS", 30_000, 0);
}

interface ParseJob {
  id: number;
  filePath: string;
  resolve: (entries: unknown[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

class ParseWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: ParseJob[] = [];
  private jobByWorker = new Map<Worker, ParseJob>();
  private idleReapers = new Map<Worker, NodeJS.Timeout>();
  private nextJobId = 1;
  private spawnFailures = 0;

  get queued(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.jobByWorker.size;
  }

  private spawn(): Worker | null {
    try {
      const worker = new Worker(WORKER_SOURCE, { eval: true });
      worker.unref();
      worker.on("message", (message: { id: number; ok: boolean; entries?: unknown[]; error?: string }) => {
        const job = this.jobByWorker.get(worker);
        if (!job || job.id !== message.id) return;
        this.settle(worker, job);
        this.idle.push(worker);
        if (message.ok && Array.isArray(message.entries)) job.resolve(message.entries);
        else job.reject(new Error(message.error ?? "worker parse failed"));
        this.dispatch();
      });
      worker.on("error", (error: Error) => this.failWorker(worker, error));
      worker.on("exit", (code) => {
        if (code !== 0) this.failWorker(worker, new Error(`parse worker exited with code ${code}`));
      });
      this.workers.push(worker);
      this.spawnFailures = 0;
      return worker;
    } catch (error) {
      this.spawnFailures += 1;
      console.warn("[pi-web] failed to spawn session parse worker:", error instanceof Error ? error.message : error);
      return null;
    }
  }

  private failWorker(worker: Worker, error: Error): void {
    const job = this.jobByWorker.get(worker);
    this.settle(worker, job ?? null);
    job?.reject(error);
    this.dropWorker(worker);
    this.dispatch();
  }

  private settle(worker: Worker, job: ParseJob | null): void {
    if (job) {
      if (job.timer) clearTimeout(job.timer);
      this.jobByWorker.delete(worker);
    }
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex !== -1) this.idle.splice(idleIndex, 1);
    const reaper = this.idleReapers.get(worker);
    if (reaper) {
      clearTimeout(reaper);
      this.idleReapers.delete(worker);
    }
  }

  /**
   * A worker that has exchanged messages keeps the event loop alive even
   * after unref() (its MessagePort is ref'd), so idle workers are terminated
   * after PARSE_IDLE_REAP_MS instead of staying warm forever. A warm pool
   * only matters for parse bursts; a respawn costs ~40ms.
   */
  private scheduleReap(worker: Worker): void {
    if (this.idleReapers.has(worker)) return;
    const timer = setTimeout(() => {
      this.idleReapers.delete(worker);
      if (this.jobByWorker.has(worker)) return;
      this.dropWorker(worker);
    }, parseIdleReapMs());
    timer.unref?.();
    this.idleReapers.set(worker, timer);
  }

  private dropWorker(worker: Worker): void {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    const reaper = this.idleReapers.get(worker);
    if (reaper) {
      clearTimeout(reaper);
      this.idleReapers.delete(worker);
    }
    void worker.terminate().catch(() => {});
  }

  terminateAll(): void {
    for (const worker of [...this.workers]) this.dropWorker(worker);
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let worker: Worker | null | undefined = this.idle.pop();
      if (worker) this.settle(worker, null);
      if (!worker) {
        const wanted = parseWorkerCount();
        if (this.workers.length >= wanted || this.spawnFailures > 3) return;
        worker = this.spawn();
        if (!worker) return;
      }
      const job = this.queue.shift();
      if (!job) {
        this.idle.push(worker);
        this.scheduleReap(worker);
        return;
      }
      this.jobByWorker.set(worker, job);
      job.timer = setTimeout(() => {
        this.failWorker(worker, new Error(`session parse timed out after ${parseTimeoutMs()}ms`));
      }, parseTimeoutMs());
      job.timer.unref?.();
      worker.postMessage({ id: job.id, filePath: job.filePath });
    }
    // No queued work left: every idle worker gets a reap deadline.
    for (const worker of this.idle) this.scheduleReap(worker);
  }

  submit(filePath: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextJobId++, filePath, resolve, reject, timer: null });
      this.dispatch();
    });
  }
}

declare global {
   
  var __piWebParsePool: ParseWorkerPool | undefined;
}

function getParsePool(): ParseWorkerPool {
  if (!globalThis.__piWebParsePool) globalThis.__piWebParsePool = new ParseWorkerPool();
  return globalThis.__piWebParsePool;
}

function constructFromPreloaded(
  filePath: string,
  sessionDir: string | undefined,
  entries: unknown[],
): SessionManager {
  const header = entries[0] as { cwd?: unknown } | undefined;
  const cwd = header && typeof header.cwd === "string" && header.cwd ? header.cwd : process.cwd();
  const dir = sessionDir ?? dirname(resolvePath(filePath));
  return new SessionManagerCtor(cwd, dir, resolvePath(filePath), true, undefined, entries);
}

function parseInWorker(filePath: string): Promise<unknown[]> | null {
  if (parseWorkerCount() <= 0) return null;
  return getParsePool().submit(filePath);
}

function cacheInsert(filePath: string, stats: { fingerprint: string; bytes: number }, sm: SessionManager): void {
  if (stats.bytes > SM_CACHE_LIMITS.maxFileBytes) return; // too large to hold
  const cache = getSmCache();
  const pathKey = sessionPathKey(filePath);
  cache.set(pathKey, { sm, fingerprint: stats.fingerprint, bytes: stats.bytes });
  evictSmCache(cache);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface OpenSessionManagerOptions {
  /**
   * The caller intends to append/branch/rewrite through this manager (live
   * wrapper, set_tools, rename, fork sources): always a fresh open, never the
   * shared read-only cache.
   */
  mutable?: boolean;
  /** Optional session dir override, as SDK `open(path, sessionDir)`. */
  sessionDir?: string;
}

/**
 * Synchronous open with the read-only cache (upstream shape). Large files
 * still parse on the event loop here — request paths should prefer
 * openSessionManagerAsync.
 */
export function openSessionManager(
  filePath: string,
  options: OpenSessionManagerOptions = {},
): SessionManager {
  if (options.mutable) return SessionManager.open(filePath, options.sessionDir);

  const cache = getSmCache();
  const pathKey = sessionPathKey(filePath);
  const stats = sessionFileStats(filePath);
  if (stats === null) {
    cache.delete(pathKey);
    return SessionManager.open(filePath, options.sessionDir);
  }

  const cached = cache.get(pathKey);
  if (cached && cached.fingerprint === stats.fingerprint) {
    // LRU touch.
    cache.delete(pathKey);
    cache.set(pathKey, cached);
    recordSessionOpen("lru", 0);
    return cached.sm;
  }

  const startedAt = performance.now();
  const sm = SessionManager.open(filePath, options.sessionDir);
  recordSessionOpen("sync", performance.now() - startedAt);
  if (stats.bytes <= SM_CACHE_LIMITS.maxFileBytes) {
    cache.set(pathKey, { sm, fingerprint: stats.fingerprint, bytes: stats.bytes });
    evictSmCache(cache);
  }
  return sm;
}

let workerFallbackLoggedAt = 0;

/**
 * Async open: read-only cache first, then the worker parser for large files,
 * then the synchronous SDK open as fallback. `mutable` opens skip the cache
 * but still parse large files in a worker — the login-wave restore path.
 */
export async function openSessionManagerAsync(
  filePath: string,
  options: OpenSessionManagerOptions = {},
): Promise<SessionManager> {
  if (options.mutable) {
    const stats = sessionFileStats(filePath);
    if (stats && stats.bytes >= parseWorkerMinBytes()) {
      const startedAt = performance.now();
      try {
        const entries = await parseInWorker(filePath);
        if (entries) {
          const sm = constructFromPreloaded(filePath, options.sessionDir, entries);
          recordSessionOpen("worker", performance.now() - startedAt);
          return sm;
        }
      } catch (error) {
        const now = Date.now();
        if (now - workerFallbackLoggedAt > 60_000) {
          workerFallbackLoggedAt = now;
          logServerEvent("session_parse_worker_fallback", { filePath, error: String(error) });
          console.warn(
            "[pi-web] session parse worker failed, falling back to synchronous open:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    return SessionManager.open(filePath, options.sessionDir);
  }

  const cache = getSmCache();
  const pathKey = sessionPathKey(filePath);
  const stats = sessionFileStats(filePath);
  if (stats === null) {
    cache.delete(pathKey);
    return SessionManager.open(filePath, options.sessionDir);
  }

  const cached = cache.get(pathKey);
  if (cached && cached.fingerprint === stats.fingerprint) {
    cache.delete(pathKey);
    cache.set(pathKey, cached);
    recordSessionOpen("lru", 0);
    return cached.sm;
  }

  if (stats.bytes >= parseWorkerMinBytes()) {
    const restore = perfStats().restore;
    restore.queued += 1;
    const startedAt = performance.now();
    try {
      const entries = await parseInWorker(filePath);
      if (entries) {
        const sm = constructFromPreloaded(filePath, options.sessionDir, entries);
        cacheInsert(filePath, stats, sm);
        recordSessionOpen("worker", performance.now() - startedAt);
        return sm;
      }
    } catch (error) {
      const now = Date.now();
      if (now - workerFallbackLoggedAt > 60_000) {
        workerFallbackLoggedAt = now;
        logServerEvent("session_parse_worker_fallback", { filePath, error: String(error) });
        console.warn(
          "[pi-web] session parse worker failed, falling back to synchronous open:",
          error instanceof Error ? error.message : error,
        );
      }
    } finally {
      restore.queued -= 1;
    }
  }

  const startedAt = performance.now();
  const sm = SessionManager.open(filePath, options.sessionDir);
  recordSessionOpen("sync", performance.now() - startedAt);
  cacheInsert(filePath, stats, sm);
  return sm;
}

/** Read-only stats for the debug endpoint. */
export function sessionParseQueueDepth(): { queued: number; active: number } {
  const pool = globalThis.__piWebParsePool;
  return pool ? { queued: pool.queued, active: pool.active } : { queued: 0, active: 0 };
}

/** Test seam: drop all caches and terminate any pool workers. */
export function resetSessionOpenForTests(): void {
  globalThis.__piWebParsePool?.terminateAll();
  globalThis.__piWebSmCache = undefined;
  globalThis.__piWebParsePool = undefined;
}
