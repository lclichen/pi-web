import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Process-level perf counters for the debug panel and load tests (dev 批次1).
 *
 * State lives on globalThis because route handlers and instrumentation are
 * bundled into separate module graphs — a plain module-level object would be
 * one island per graph. Batches 2/3 bump the restore/scan counters from the
 * session-open and list-scan paths; GET /api/agent/debug reads the snapshot.
 */

export interface RestoreStats {
  /** Big-file parses waiting for a worker slot. */
  queued: number;
  /** Parses currently running on a worker. */
  active: number;
  /** Total openSessionManager completions (any path). */
  completed: number;
  workerParses: number;
  syncParses: number;
  lruHits: number;
  totalParseMs: number;
  maxParseMs: number;
  lastParseMs: number;
}

export interface ScanStats {
  lastMs: number;
  maxMs: number;
  count: number;
  /** Files fully (re)scanned on the last pass — the incremental-scanner cost. */
  lastChangedFiles: number;
}

export interface PerfStatsState {
  restore: RestoreStats;
  scan: ScanStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __piWebPerfStats: PerfStatsState | undefined;
  // eslint-disable-next-line no-var
  var __piWebLoopMonitor: IntervalHistogram | undefined;
}

export function perfStats(): PerfStatsState {
  if (!globalThis.__piWebPerfStats) {
    globalThis.__piWebPerfStats = {
      restore: {
        queued: 0,
        active: 0,
        completed: 0,
        workerParses: 0,
        syncParses: 0,
        lruHits: 0,
        totalParseMs: 0,
        maxParseMs: 0,
        lastParseMs: 0,
      },
      scan: { lastMs: 0, maxMs: 0, count: 0, lastChangedFiles: 0 },
    };
  }
  return globalThis.__piWebPerfStats;
}

/** Start the event-loop delay histogram once (from instrumentation). */
export function ensureEventLoopMonitor(): void {
  if (globalThis.__piWebLoopMonitor) return;
  try {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    globalThis.__piWebLoopMonitor = histogram;
  } catch {
    // Unavailable in this runtime — debug reports null delay instead.
  }
}

export interface EventLoopDelaySnapshot {
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

/** Read mean/p95/max since the previous read, then reset the histogram. */
export function readEventLoopDelayAndReset(): EventLoopDelaySnapshot | null {
  const histogram = globalThis.__piWebLoopMonitor;
  if (!histogram) return null;
  try {
    // An empty window (no samples since the last read) reports NaN — surface 0.
    const nanToZero = (nanoseconds: number): number => (Number.isFinite(nanoseconds) ? nanoseconds / 1e6 : 0);
    const snapshot: EventLoopDelaySnapshot = {
      meanMs: nanToZero(histogram.mean),
      p95Ms: nanToZero(histogram.percentile(95)),
      maxMs: nanToZero(histogram.max),
    };
    histogram.reset();
    return snapshot;
  } catch {
    return null;
  }
}

export type PerfStatsSnapshot = {
  restore: RestoreStats;
  scan: ScanStats;
};

/** Deep copy for the debug endpoint. */
export function perfStatsSnapshot(): PerfStatsSnapshot {
  const s = perfStats();
  return {
    restore: { ...s.restore },
    scan: { ...s.scan },
  };
}

/** Record one session-open outcome into the restore counters. */
export function recordSessionOpen(
  kind: "worker" | "sync" | "lru",
  durationMs: number,
): void {
  const restore = perfStats().restore;
  restore.completed += 1;
  restore.lastParseMs = Math.round(durationMs * 100) / 100;
  restore.totalParseMs += durationMs;
  restore.maxParseMs = Math.max(restore.maxParseMs, durationMs);
  if (kind === "worker") restore.workerParses += 1;
  else if (kind === "sync") restore.syncParses += 1;
  else restore.lruHits += 1;
}

/** Record one incremental list-scan pass. */
export function recordSessionScan(durationMs: number, changedFiles: number): void {
  const scan = perfStats().scan;
  scan.lastMs = Math.round(durationMs * 100) / 100;
  scan.maxMs = Math.max(scan.maxMs, scan.lastMs);
  scan.count += 1;
  scan.lastChangedFiles = changedFiles;
}
