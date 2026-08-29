// Client-side helper for POST /api/agent-relay/rpc. Mirrors lib/agent-client.ts:
// same { success, data } / { error } envelope and error convention.
import type { FsEntry, FsReadResult, FsStatResult, ExecResult, AgentInfo, GrepMatch }  from "./relay/protocol";

export async function relayRpc<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("/api/agent-relay/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
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
  list: (path: string) => relayRpc<FsEntry[]>("fs.list", { path }),
  read: (path: string) => relayRpc<FsReadResult>("fs.read", { path }),
  write: (path: string, content: string) => relayRpc<{ ok: boolean; size: number }>("fs.write", { path, content }),
  stat: (path: string) => relayRpc<FsStatResult>("fs.stat", { path }),
  mkdir: (path: string) => relayRpc<{ ok: boolean }>("fs.mkdir", { path }),
  delete: (path: string) => relayRpc<{ ok: boolean }>("fs.delete", { path }),
  rename: (from: string, to: string) => relayRpc<{ ok: boolean; path: string }>("fs.rename", { from, to }),
};

export const relaySearch = {
  grep: (pattern: string, opts?: { path?: string; glob?: string; maxResults?: number }) =>
    relayRpc<GrepMatch[]>("search.grep", { pattern, ...opts }),
  fd: (pattern: string, opts?: { path?: string; type?: "f" | "d"; maxResults?: number }) =>
    relayRpc<string[]>("search.fd", { pattern, ...opts }),
};

export function relayExec(argv: string[], cwd = ".", timeout?: number) {
  return relayRpc<ExecResult>("exec.run", { argv, cwd, ...(timeout ? { timeout } : {}) });
}

/** Hot-swap the agent's workspace root (validated, persisted to the agent's
 *  config.json; requires agent ≥ v0.1.2). */
export async function relaySetWorkspaceRoot(path: string): Promise<{ root: string }> {
  return relayRpc<{ root: string }>("workspace.set-root", { path });
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
): Promise<{ exitCode: number }> {
  const res = await fetch("/api/agent-relay/rpc/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "exec.stream",
      params: { argv, cwd, ...(timeout ? { timeout } : {}) },
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
