// Client-side helper for POST /api/agent-relay/rpc. Mirrors lib/agent-client.ts:
// same { success, data } / { error } envelope and error convention.
import type { FsEntry, FsReadResult, FsStatResult, ExecResult, AgentInfo } from "@/lib/relay/protocol";

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
};

export function relayExec(argv: string[], cwd = ".", timeout?: number) {
  return relayRpc<ExecResult>("exec.run", { argv, cwd, ...(timeout ? { timeout } : {}) });
}

export type { AgentInfo };
