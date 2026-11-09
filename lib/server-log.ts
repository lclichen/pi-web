import { appendFile, mkdir, readdir, rename, stat, unlink } from "fs/promises";
import { join } from "path";
import { dataDir } from "./mode-homes.ts";

/**
 * Best-effort file log for the pi-web server process (dev 批次1).
 *
 * Motivation: the "app froze, frontend inaccessible, no logs retained"
 * incident — the whole codebase only ever wrote console.* to stdout, so an
 * OOM kill (or a wrapper that lost the pipe) erased every diagnostic. This
 * module tees console.warn/error and structured perf events into
 * `<dataDir>/logs/server-YYYYMMDD.log` through a serialized async queue:
 *
 * - writes never block the event loop and never throw into callers;
 * - a day rollover rotates the file and prunes files older than
 *   PI_WEB_LOG_RETENTION_DAYS (default 7, 0 = keep all);
 * - a single file is capped at PI_WEB_LOG_MAX_BYTES (default 50 MB), the
 *   overflow goes to `server-<day>.1.log` (one generation);
 * - after 3 consecutive write failures logging disables itself (circuit
 *   breaker) instead of spinning — the process keeps serving;
 * - PI_WEB_FILE_LOG=0 disables everything at startup.
 */

type LogKind = "error" | "warn" | "info" | "event";

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;

function maxFileBytes(): number {
  const raw = Number(process.env.PI_WEB_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw >= 64 * 1024 ? raw : DEFAULT_MAX_FILE_BYTES;
}

function retentionDays(): number {
  const raw = Number(process.env.PI_WEB_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_RETENTION_DAYS;
}

export function fileLogEnabled(): boolean {
  return process.env.PI_WEB_FILE_LOG !== "0";
}

interface LogState {
  dayStamp: string;
  filePath: string;
  /** Bytes appended since the last rotation check (avoids stat per line). */
  currentBytes: number;
  queue: Promise<void>;
  consecutiveFailures: number;
  disabled: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __piWebServerLog: LogState | undefined;
  // eslint-disable-next-line no-var
  var __piWebConsoleTeed: boolean | undefined;
}

function state(): LogState {
  if (!globalThis.__piWebServerLog) {
    globalThis.__piWebServerLog = {
      dayStamp: "",
      filePath: "",
      currentBytes: 0,
      queue: Promise.resolve(),
      consecutiveFailures: 0,
      disabled: false,
    };
  }
  return globalThis.__piWebServerLog;
}

function logsDir(): string {
  return join(dataDir(), "logs");
}

function dayStampOf(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function stderrNote(message: string): void {
  try {
    process.stderr.write(`[pi-web/server-log] ${message}\n`);
  } catch {
    /* nowhere left to go */
  }
}

/** Delete server-*.log files older than the retention window. Best-effort. */
async function sweepRetentionPolicy(dir: string): Promise<void> {
  const days = retentionDays();
  if (days <= 0) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const name of entries) {
    const match = /^server-(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?$/.exec(name);
    if (!match) continue;
    const fileTime = new Date(`${match[1]}T00:00:00Z`).getTime();
    if (Number.isNaN(fileTime) || fileTime >= cutoff) continue;
    try {
      await unlink(join(dir, name));
    } catch {
      /* already gone */
    }
  }
}

/** Rotate `server-<day>.log` → `server-<day>.1.log` once it passes the cap. */
async function rotateIfNeeded(s: LogState): Promise<void> {
  if (s.currentBytes <= maxFileBytes()) return;
  const rotated = s.filePath.replace(/\.log$/, ".1.log");
  try {
    await unlink(rotated).catch(() => {});
    await rename(s.filePath, rotated);
    s.currentBytes = 0;
  } catch {
    // Rotation failed (e.g. the file vanished): reset the counter anyway so a
    // permanently failing rename cannot rotate on every line.
    s.currentBytes = 0;
  }
}

async function appendLine(s: LogState, line: string): Promise<void> {
  const day = dayStampOf();
  if (day !== s.dayStamp) {
    s.dayStamp = day;
    s.filePath = join(logsDir(), `server-${day}.log`);
    s.currentBytes = 0;
    await mkdir(logsDir(), { recursive: true });
    try {
      s.currentBytes = (await stat(s.filePath)).size;
    } catch {
      s.currentBytes = 0;
    }
    await sweepRetentionPolicy(logsDir());
  }
  await rotateIfNeeded(s);
  await appendFile(s.filePath, line, "utf8");
  s.currentBytes += Buffer.byteLength(line, "utf8");
}

function enqueue(s: LogState, line: string): void {
  if (s.disabled) return;
  s.queue = s.queue
    .then(() => appendLine(s, line))
    .then(() => {
      s.consecutiveFailures = 0;
    })
    .catch(() => {
      s.consecutiveFailures += 1;
      if (s.consecutiveFailures === 3) {
        s.disabled = true;
        stderrNote("file logging disabled after repeated write failures");
      }
    });
}

function formatMessage(kind: LogKind, message: string): string {
  const text = message.replaceAll("\n", "\\n");
  return `${new Date().toISOString()} [${kind}] ${text}\n`;
}

/** Append one plain-text line (warn/error/info). Never throws. */
export function writeServerLog(kind: LogKind, message: string): void {
  if (!fileLogEnabled()) return;
  enqueue(state(), formatMessage(kind, message));
}

/** Append one structured JSON event line for perf/diagnostics point-logging. */
export function logServerEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (!fileLogEnabled()) return;
  const line = `${new Date().toISOString()} [event] ${JSON.stringify({ event, ...fields })}\n`;
  enqueue(state(), line);
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Tee console.warn/console.error into the file log (installed once from
 * instrumentation-node). The wrappers keep the original console behavior, so
 * Next.js output and deploy log capture are unchanged.
 */
export function installServerLogTee(): void {
  if (!fileLogEnabled()) return;
  if (globalThis.__piWebConsoleTeed) return;
  globalThis.__piWebConsoleTeed = true;
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    writeServerLog("warn", formatConsoleArgs(args));
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeServerLog("error", formatConsoleArgs(args));
    originalError(...args);
  };
}

/** Test seam: drop all state and re-enable logging. */
export function resetServerLogForTests(): void {
  globalThis.__piWebServerLog = undefined;
  globalThis.__piWebConsoleTeed = undefined;
}
