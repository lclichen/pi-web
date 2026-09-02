import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { platformUrl } from "./platform/client";
import { relayRpc } from "./relay/forward";
import { subscribePtyOutput } from "./relay/registry";
import { getSshClient } from "./ssh";
import type { RemoteSessionContext } from "./remote-session";

/**
 * Remote terminals for sandbox / local-machine / ssh sessions — same registry
 * and SSE fan-out shape as lib/local-terminal.ts, three transports:
 *
 *  - sandbox: a server-side WebSocket bridge to the platform's
 *    GET /containers/:id/pty?token= (JSON frames ready/output/exit/input/
 *    resize). Browsers never see the platform token (BFF, design doc §3).
 *  - local-machine: the Go relay's pty.create/input/resize/close RPCs plus
 *    its pty.output push fan-out.
 *  - ssh: an interactive `shell()` channel on the project's pooled ssh2
 *    connection (xterm-compatible PTY, cwd = remote workdir).
 */

export type RemoteTerminalFrame =
  | { type: "output"; data: string }
  | { type: "exit"; code: number };

/** Minimal ssh2 ClientChannel surface used here. */
interface SshShellStream {
  write(data: string): boolean;
  end(): void;
  close(): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  on(event: "data", cb: (d: Buffer) => void): unknown;
  on(event: "close", cb: () => void): unknown;
}

interface RemoteTerminal {
  kind: "platform" | "relay" | "ssh";
  ctx: RemoteSessionContext;
  subscribers: Set<(frame: RemoteTerminalFrame) => void>;
  exited: number | undefined;
  createdAt: number;
  /** platform: the bridge socket; relay: unsubscribe + close call. */
  ws?: WebSocket;
  detach?: () => void;
  /** relay: the agent-side pty session id. */
  relayAgentSid?: string;
  /** ssh: the interactive shell channel. */
  sshStream?: SshShellStream;
  /** Pending last-viewer-gone cleanup (see subscribeRemoteTerminal). */
  orphanTimer?: ReturnType<typeof setTimeout>;
}

interface Registry {
  terminals: Map<string, RemoteTerminal>;
  reaperStarted: boolean;
}

const GLOBAL_KEY = Symbol.for("pi-web.remote-terminals");

function getRegistry(): Registry {
  const g = globalThis as Record<symbol, Registry | undefined>;
  let reg = g[GLOBAL_KEY];
  if (!reg) {
    reg = { terminals: new Map(), reaperStarted: false };
    g[GLOBAL_KEY] = reg;
  }
  return reg;
}

const IDLE_KILL_MS = 30 * 60 * 1000;

function ensureReaper(): void {
  const reg = getRegistry();
  if (reg.reaperStarted) return;
  reg.reaperStarted = true;
  setInterval(() => {
    // The platform enforces its own idle timeout; here we only reap entries
    // nobody subscribed to anymore (closed tab) so maps can't grow forever.
    const now = Date.now();
    for (const [sid, t] of reg.terminals) {
      if (t.subscribers.size === 0 && now - t.createdAt > IDLE_KILL_MS) {
        closeRemoteTerminal(sid);
      }
    }
  }, 5 * 60 * 1000).unref?.();
}

function notify(t: RemoteTerminal, frame: RemoteTerminalFrame): void {
  for (const cb of t.subscribers) {
    try {
      cb(frame);
    } catch {
      // ignore
    }
  }
}

export async function createRemoteTerminal(
  ctx: RemoteSessionContext,
  opts: { cols: number; rows: number; cwd?: string },
): Promise<{ sessionId: string }> {
  const reg = getRegistry();
  if (reg.terminals.size >= 8) throw new Error("远程终端数量已达上限（8）");
  ensureReaper();

  const sid = randomUUID();
  const entry: RemoteTerminal = {
    kind: ctx.mode === "sandbox" ? "platform" : ctx.mode === "ssh" ? "ssh" : "relay",
    ctx,
    subscribers: new Set(),
    exited: undefined,
    createdAt: Date.now(),
  };
  reg.terminals.set(sid, entry);

  if (entry.kind === "platform") {
    const url = `${platformUrl().replace(/^http/, "ws")}/api/v1/containers/${ctx.containerId}/pty?token=${encodeURIComponent(ctx.apiKey)}`;
    const ws = new WebSocket(url);
    entry.ws = ws;
    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const frame = JSON.parse(raw.toString()) as { type?: string; data?: string; code?: number };
        if (frame.type === "output" && typeof frame.data === "string") {
          notify(entry, { type: "output", data: frame.data });
        } else if (frame.type === "exit") {
          entry.exited = typeof frame.code === "number" ? frame.code : 0;
          notify(entry, { type: "exit", code: entry.exited });
        }
      } catch {
        // ignore malformed frames
      }
    });
    ws.on("close", () => {
      if (entry.exited === undefined) {
        entry.exited = 0;
        notify(entry, { type: "exit", code: 0 });
      }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "resize", cols: opts.cols, rows: opts.rows }));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接沙箱终端超时")), 10_000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (err: Error) => { clearTimeout(timer); reject(err); });
    }).catch((err) => {
      reg.terminals.delete(sid);
      throw err;
    });
  } else if (entry.kind === "ssh") {
    // ssh: interactive shell() channel on the project's pooled connection.
    // cwd: the channel starts at the account home; cd into the project's
    // remote workdir (echoed once — same as typing it).
    if (!ctx.projectId || !ctx.sshConfig) throw new Error("SSH 会话缺少连接配置");
    const client = await getSshClient(ctx.projectId, ctx.sshConfig);
    const stream = await new Promise<SshShellStream>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 SSH 终端超时")), 10_000);
      client.shell({ term: "xterm-256color", cols: opts.cols, rows: opts.rows }, (err: Error | undefined, s: unknown) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(s as SshShellStream);
      });
    }).catch((err) => {
      reg.terminals.delete(sid);
      throw err;
    });
    entry.sshStream = stream;
    stream.on("data", (d: Buffer) => notify(entry, { type: "output", data: d.toString("utf8") }));
    stream.on("close", () => {
      if (entry.exited === undefined) {
        entry.exited = 0;
        notify(entry, { type: "exit", code: 0 });
      }
    });
    const wd = (ctx.workdir ?? "").trim();
    if (wd && wd !== "/") stream.write(`cd '${wd.replace(/'/g, `'\\''`)}'\n`);
  } else {
    // relay: pty.create returns the agent-side session id; output arrives as
    // unsolicited pty.output pushes fanned out by subscribePtyOutput.
    const created = await relayRpc(
      "pty.create",
      { cwd: opts.cwd ?? ".", cols: opts.cols, rows: opts.rows },
      { userId: ctx.userId },
    ) as { sessionId?: string };
    const agentSid = created?.sessionId;
    if (!agentSid) throw new Error("本机 agent 未返回终端会话");
    entry.relayAgentSid = agentSid;
    entry.detach = subscribePtyOutput(agentSid, (data) => {
      notify(entry, { type: "output", data });
    });
  }

  return { sessionId: sid };
}

export function writeRemoteTerminal(sid: string, data: string): void {
  const t = getRegistry().terminals.get(sid);
  if (!t || t.exited !== undefined) return;
  if (t.kind === "platform") {
    if (t.ws?.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: "input", data }));
  } else if (t.kind === "ssh") {
    try {
      t.sshStream?.write(data);
    } catch {
      // channel already dead; close frame arrives via the close handler
    }
  } else {
    // relay input is keyed by our sid → agent sid mapping via ctx; re-discover
    // is overkill: the relay input method needs the agent-side id, so store it.
    if (t.detach) void relayRpc("pty.input", { sessionId: t.relayAgentSid, data }, { userId: t.ctx.userId }).catch(() => {});
  }
}

export function resizeRemoteTerminal(sid: string, cols: number, rows: number): void {
  const t = getRegistry().terminals.get(sid);
  if (!t || t.exited !== undefined) return;
  if (t.kind === "platform") {
    if (t.ws?.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  } else if (t.kind === "ssh") {
    try {
      t.sshStream?.setWindow(rows, cols, rows * 16, cols * 8);
    } catch {
      // ignore
    }
  } else {
    void relayRpc("pty.resize", { sessionId: t.relayAgentSid, cols, rows }, { userId: t.ctx.userId }).catch(() => {});
  }
}

export function closeRemoteTerminal(sid: string): void {
  const reg = getRegistry();
  const t = reg.terminals.get(sid);
  if (!t) return;
  reg.terminals.delete(sid);
  if (t.orphanTimer) {
    clearTimeout(t.orphanTimer);
    t.orphanTimer = undefined;
  }
  if (t.kind === "platform") {
    try {
      t.ws?.close();
    } catch {
      // ignore
    }
  } else if (t.kind === "ssh") {
    try {
      t.sshStream?.end();
      t.sshStream?.close();
    } catch {
      // ignore
    }
  } else {
    t.detach?.();
    void relayRpc("pty.close", { sessionId: t.relayAgentSid }, { userId: t.ctx.userId }).catch(() => {});
  }
}

/** Close a terminal this quickly after its last subscriber disappears. */
const ORPHAN_CLOSE_MS = 60_000;

export function subscribeRemoteTerminal(
  sid: string,
  cb: (frame: RemoteTerminalFrame) => void,
): () => void {
  const reg = getRegistry();
  const t = reg.terminals.get(sid);
  if (!t) return () => {};
  t.subscribers.add(cb);
  // Cancel any pending orphan cleanup — the browser is (re)subscribed.
  if (t.orphanTimer) {
    clearTimeout(t.orphanTimer);
    t.orphanTimer = undefined;
  }
  if (t.exited !== undefined) {
    try {
      cb({ type: "exit", code: t.exited });
    } catch {
      // ignore
    }
  }
  return () => {
    t.subscribers.delete(cb);
    // Last viewer gone (tab closed/refreshed): don't hold the platform PTY
    // slot until the 30-min reaper — the platform caps concurrent terminals
    // per container and rejects further upgrades with 429 once leaked
    // sessions pile up. Short grace covers brief SSE reconnects.
    if (t.subscribers.size === 0 && t.exited === undefined && !t.orphanTimer) {
      t.orphanTimer = setTimeout(() => {
        t.orphanTimer = undefined;
        if (getRegistry().terminals.get(sid) === t && t.subscribers.size === 0) {
          closeRemoteTerminal(sid);
        }
      }, ORPHAN_CLOSE_MS);
      t.orphanTimer.unref?.();
    }
  };
}

