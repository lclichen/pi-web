// Client-side helper for POST /api/agent-relay/rpc. Mirrors lib/agent-client.ts:
// same { success, data } / { error } envelope and error convention.
import type { FsEntry, FsReadResult, FsStatResult, ExecResult, AgentInfo, GrepMatch }  from "./relay/protocol";

export interface RelayCallOpts {
  /** Target one specific paired machine (multi-machine); omit = default. */
  machineId?: string;
}

export async function relayRpc<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  opts?: RelayCallOpts,
): Promise<T> {
  const res = await fetch("/api/agent-relay/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params, ...(opts?.machineId ? { machineId: opts.machineId } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.data as T;
}

export const relayFs = {
  list: (path: string, call?: RelayCallOpts) => relayRpc<FsEntry[]>("fs.list", { path }, call),
  read: (path: string, call?: RelayCallOpts) => relayRpc<FsReadResult>("fs.read", { path }, call),
  write: (path: string, content: string, call?: RelayCallOpts) => relayRpc<{ ok: boolean; size: number }>("fs.write", { path, content }, call),
  stat: (path: string, call?: RelayCallOpts) => relayRpc<FsStatResult>("fs.stat", { path }, call),
  mkdir: (path: string, call?: RelayCallOpts) => relayRpc<{ ok: boolean }>("fs.mkdir", { path }, call),
  delete: (path: string, call?: RelayCallOpts) => relayRpc<{ ok: boolean }>("fs.delete", { path }, call),
  rename: (from: string, to: string, call?: RelayCallOpts) => relayRpc<{ ok: boolean; path: string }>("fs.rename", { from, to }, call),
};

export const relaySearch = {
  grep: (pattern: string, opts?: { path?: string; glob?: string; maxResults?: number }, call?: RelayCallOpts) =>
    relayRpc<GrepMatch[]>("search.grep", { pattern, ...opts }, call),
  fd: (pattern: string, opts?: { path?: string; type?: "f" | "d"; maxResults?: number }, call?: RelayCallOpts) =>
    relayRpc<string[]>("search.fd", { pattern, ...opts }, call),
};

export function relayExec(argv: string[], cwd = ".", timeout?: number) {
  return relayRpc<ExecResult>("exec.run", { argv, cwd, ...(timeout ? { timeout } : {}) });
}

/** Hot-swap the agent's workspace root (validated, persisted to the agent's
 *  config.json; requires agent ≥ v0.1.2). */
export async function relaySetWorkspaceRoot(path: string, opts?: RelayCallOpts): Promise<{ root: string }> {
  return relayRpc<{ root: string }>("workspace.set-root", { path }, opts);
}

export interface ExecChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * Streaming exec via POST /api/agent-relay/rpc/stream (SSE body). Invokes
 * onChunk for each streamed stdout/stderr frame and resolves with the exit
 * code once the terminal `end` frame arrives. Gives the panel a live,
 * scrolling command output.
 */
export async function relayStreamExec(
  argv: string[],
  cwd: string,
  onChunk: (c: ExecChunk) => void,
  timeout?: number,
  opts?: RelayCallOpts,
): Promise<{ exitCode: number }> {
  const res = await fetch("/api/agent-relay/rpc/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "exec.stream",
      params: { argv, cwd, ...(timeout ? { timeout } : {}) },
      ...(opts?.machineId ? { machineId: opts.machineId } : {}),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let exitCode = 0;
  let ended = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      let payload: { type?: string; data?: ExecChunk; ok?: boolean; error?: string; result?: { exitCode?: number } };
      try {
        payload = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      if (payload.type === "chunk" && payload.data) {
        onChunk(payload.data);
      } else if (payload.type === "end") {
        ended = true;
        if (!payload.ok) throw new Error(payload.error ?? "stream failed");
        if (payload.result?.exitCode != null) exitCode = payload.result.exitCode;
      }
    }
  }
  if (!ended) throw new Error("stream ended unexpectedly");
  return { exitCode };
}

export type { AgentInfo };
