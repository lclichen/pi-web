import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolveShell, type ShellInfo } from "./shell-resolver";

/**
 * Local workspace terminal registry — PTY sessions spawned on the pi-web
 * server host itself (ConPTY on Windows, forkpty on POSIX). This is the
 * server-local sibling of the Go relay agent's PTY (lib/relay/registry.ts):
 * same fan-out shape (SSE routes subscribe to output), different process
 * boundary.
 *
 * The registry lives on globalThis so Next.js dev-mode route reloads and the
 * multiple route modules sharing it see one map.
 */

type PtyModule = typeof import("@homebridge/node-pty-prebuilt-multiarch");
type PtySpawn = PtyModule["spawn"];
type IPty = ReturnType<PtySpawn>;

export type TerminalFrame =
  | { type: "output"; data: string }
  | { type: "exit"; code: number };

interface LocalTerminal {
  pty: IPty;
  shell: ShellInfo;
  cwd: string;
  cols: number;
  rows: number;
  subscribers: Set<(frame: TerminalFrame) => void>;
  lastActivity: number;
  /** Set once the process exits; late subscribers get the frame replayed. */
  exited: number | undefined;
}

interface TerminalRegistry {
  terminals: Map<string, LocalTerminal>;
  reaperStarted: boolean;
}

const GLOBAL_KEY = Symbol.for("pi-web.local-terminals");

function getRegistry(): TerminalRegistry {
  const g = globalThis as Record<symbol, TerminalRegistry | undefined>;
  let reg = g[GLOBAL_KEY];
  if (!reg) {
    reg = { terminals: new Map(), reaperStarted: false };
    g[GLOBAL_KEY] = reg;
  }
  return reg;
}

const MAX_TERMINALS = 8;
const IDLE_KILL_MS = 30 * 60 * 1000;

let ptyModule: PtyModule | null = null;
let ptyLoadError: string | null = null;

async function loadPty(): Promise<PtyModule> {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw new Error(ptyLoadError);
  try {
    // serverExternalPackages keeps this out of the webpack bundle; loaded
    // lazily so a missing/broken native module degrades to an API error
    // instead of crashing the whole server at import time. The package is
    // CJS: pick spawn off the namespace or the default interop wrapper,
    // whichever the runtime synthesized.
    const mod = (await import("@homebridge/node-pty-prebuilt-multiarch")) as unknown as {
      spawn?: PtySpawn;
      default?: { spawn?: PtySpawn };
    };
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (typeof spawn !== "function") {
      throw new Error("缺少 spawn 导出");
    }
    ptyModule = { spawn } as PtyModule;
    return ptyModule;
  } catch (err) {
    ptyLoadError = `PTY 模块加载失败：${err instanceof Error ? err.message : String(err)}`;
    throw new Error(ptyLoadError);
  }
}

function ensureReaper(): void {
  const reg = getRegistry();
  if (reg.reaperStarted) return;
  reg.reaperStarted = true;
  // Kill terminals nobody is watching (SSE disconnected) and that have been
  // idle for a long time — a closed browser tab must not leak shells forever.
  setInterval(() => {
    const now = Date.now();
    for (const [sid, t] of reg.terminals) {
      if (t.subscribers.size === 0 && now - t.lastActivity > IDLE_KILL_MS) {
        closeLocalTerminal(sid);
      }
    }
  }, 5 * 60 * 1000).unref?.();
}

function notify(t: LocalTerminal, frame: TerminalFrame): void {
  for (const cb of t.subscribers) {
    try {
      cb(frame);
    } catch {
      // ignore subscriber errors
    }
  }
}

export interface CreateTerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export async function createLocalTerminal(opts: CreateTerminalOptions): Promise<{
  sessionId: string;
  shell: ShellInfo;
}> {
  if (process.env.PI_WEB_TERMINAL_ENABLED === "0") {
    throw new Error("终端功能已被 PI_WEB_TERMINAL_ENABLED=0 禁用");
  }
  const reg = getRegistry();

  let isDir = false;
  try {
    isDir = statSync(opts.cwd).isDirectory();
  } catch {
    // fall through
  }
  if (!isDir) throw new Error(`工作目录不存在：${opts.cwd}`);

  if (reg.terminals.size >= MAX_TERMINALS) {
    throw new Error(`终端数量已达上限（${MAX_TERMINALS}），请先关闭不需要的终端`);
  }

  const shell = resolveShell(opts.shell);
  const cols = Math.max(2, Math.min(500, Math.floor(opts.cols ?? 80)));
  const rows = Math.max(2, Math.min(300, Math.floor(opts.rows ?? 24)));

  const pty = await loadPty();
  const proc = pty.spawn(shell.path, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });

  const sid = randomUUID();
  const entry: LocalTerminal = {
    pty: proc,
    shell,
    cwd: opts.cwd,
    cols,
    rows,
    subscribers: new Set(),
    lastActivity: Date.now(),
    exited: undefined,
  };
  reg.terminals.set(sid, entry);
  ensureReaper();

  proc.onData((data) => {
    entry.lastActivity = Date.now();
    notify(entry, { type: "output", data });
  });
  proc.onExit(({ exitCode }) => {
    entry.exited = exitCode;
    notify(entry, { type: "exit", code: exitCode });
    // Keep the entry around so a reconnecting browser learns the process is
    // gone; the reaper or an explicit close removes it.
    setTimeout(() => {
      if (getRegistry().terminals.get(sid) === entry) {
        getRegistry().terminals.delete(sid);
      }
    }, 60_000).unref?.();
  });

  return { sessionId: sid, shell };
}

export function writeLocalTerminal(sid: string, data: string): void {
  const t = getRegistry().terminals.get(sid);
  if (!t || t.exited !== undefined) return;
  t.lastActivity = Date.now();
  t.pty.write(data);
}

export function resizeLocalTerminal(sid: string, cols: number, rows: number): void {
  const t = getRegistry().terminals.get(sid);
  if (!t || t.exited !== undefined) return;
  const c = Math.max(2, Math.min(500, Math.floor(cols)));
  const r = Math.max(2, Math.min(300, Math.floor(rows)));
  t.cols = c;
  t.rows = r;
  try {
    t.pty.resize(c, r);
  } catch {
    // resize on a dying pty — ignore
  }
}

export function closeLocalTerminal(sid: string): void {
  const reg = getRegistry();
  const t = reg.terminals.get(sid);
  if (!t) return;
  reg.terminals.delete(sid);
  if (t.exited === undefined) {
    try {
      t.pty.kill();
    } catch {
      // already gone
    }
  }
}

export function subscribeLocalTerminal(
  sid: string,
  cb: (frame: TerminalFrame) => void,
): () => void {
  const reg = getRegistry();
  const t = reg.terminals.get(sid);
  if (!t) return () => {};
  t.subscribers.add(cb);
  // A shell that exited before the SSE attached still needs to be reported,
  // or the browser sits on a dead terminal with no way to know.
  if (t.exited !== undefined) {
    try {
      cb({ type: "exit", code: t.exited });
    } catch {
      // ignore
    }
  }
  return () => {
    t.subscribers.delete(cb);
  };
}
