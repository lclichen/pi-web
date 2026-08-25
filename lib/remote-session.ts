import { getRpcSessionOwner } from "./rpc-manager";
import { getSessionMeta } from "./session-metas";
import { requireUserIdentity } from "./web-session";
import { getAgentForUser } from "./relay/registry";
import { platformGet, platformPost } from "./platform/client";
import { readSandboxHomeConfig } from "./mode-homes";
import { getOwnedProject, readProjectSandboxConfig } from "./projects";
import { relayRpc } from "./relay/forward";
import type { SessionMode } from "./session-modes";

/**
 * Shared context for the mode-scoped remote APIs (remotefs / remoteterminal):
 * verifies the caller owns the session, resolves its execution mode, and
 * exposes the backend handle (platform container id or the user's relay).
 */

export interface RemoteSessionContext {
  mode: SessionMode;
  userId: number;
  apiKey: string;
  /** Sandbox mode: the container tools should target. */
  containerId: number;
  isAdmin: boolean;
}

interface PlatformContainer { id: number; status: string }

export async function resolveRemoteSession(
  req: Request,
  sessionId: string,
): Promise<{ ok: true; ctx: RemoteSessionContext } | { ok: false; status: number; error: string }> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: identity.status, error: "登录已失效" };
  const { user } = identity.session;

  // Registry first (live), sidecar metas second (reloaded sessions).
  const owner = getRpcSessionOwner(sessionId);
  const meta = getSessionMeta(sessionId);
  const mode = owner?.mode ?? meta?.mode ?? "host";
  if (mode === "host") {
    return { ok: false, status: 400, error: "该会话是 Host 模式，请使用本地文件/终端面板" };
  }
  const ownerId = owner?.ownerId ?? meta?.ownerId ?? 0;
  if (user.id !== 0 && ownerId !== user.id && user.role !== "admin") {
    return { ok: false, status: 404, error: "会话不存在" };
  }

  if (mode === "local-machine") {
    if (user.id !== 0 && !getAgentForUser(user.id)?.info) {
      return { ok: false, status: 503, error: "本机未连接（relay 离线）" };
    }
    return { ok: true, ctx: { mode, userId: user.id, apiKey: "", containerId: 0, isAdmin: user.role === "admin" } };
  }

  // Sandbox: platform credentials + target container. Prefer the container
  // bound to the session's PROJECT (source of truth — the same file the
  // sandbox extension reads); the user-level default and "any running" are
  // only fallbacks for pre-project sessions.
  if (user.id === 0 || !identity.session.apiKey) {
    return { ok: false, status: 401, error: "沙箱模式需要平台凭证，请重新登录" };
  }
  let containerId = 0;
  if (meta?.projectId) {
    const project = getOwnedProject(meta.projectId, ownerId, user.role === "admin");
    if (project && project.mode === "sandbox") {
      containerId = Number(readProjectSandboxConfig(project).containerId) || 0;
    }
  }
  if (!containerId) {
    const config = readSandboxHomeConfig(user.id);
    containerId = typeof config.containerId === "number" ? config.containerId : Number(config.containerId) || 0;
  }
  if (!containerId) {
    try {
      const list = await platformGet<{ containers: PlatformContainer[] }>(
        "/api/v1/containers",
        identity.session.apiKey,
        { filter: "running" },
      );
      containerId = list.containers?.[0]?.id ?? 0;
    } catch {
      // fall through to the explicit error below
    }
  }
  if (!containerId) {
    return { ok: false, status: 409, error: "没有运行中的沙箱容器——请先在会话里触发一次工具调用或稍后再试" };
  }
  return { ok: true, ctx: { mode, userId: user.id, apiKey: identity.session.apiKey, containerId, isAdmin: user.role === "admin" } };
}

// ---- backend helpers ----

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export async function remoteList(ctx: RemoteSessionContext, path: string): Promise<RemoteEntry[]> {
  if (ctx.mode === "local-machine") {
    const entries = await relayRpc("fs.list", { path: stripSlash(path) }, { userId: ctx.userId }) as Array<{
      name: string; isDir: boolean; size: number; mtime: number;
    }>;
    return entries.map((e) => ({ name: e.name, isDir: e.isDir, size: e.size, modified: new Date(e.mtime).toISOString() }));
  }
  const res = await platformGet<{ entries?: Array<{ name: string; isDirectory?: boolean; isDir?: boolean; size?: number; mtimeMs?: number }> }>(
    `/api/v1/containers/${ctx.containerId}/tools/ls`,
    ctx.apiKey,
    { path: containerPath(path) },
  );
  return (res.entries ?? []).map((e) => ({
    name: e.name,
    isDir: e.isDirectory ?? e.isDir ?? false,
    size: e.size ?? 0,
    modified: e.mtimeMs ? new Date(e.mtimeMs).toISOString() : "",
  }));
}

export async function remoteRead(ctx: RemoteSessionContext, path: string): Promise<{ content: string; size: number }> {
  if (ctx.mode === "local-machine") {
    const r = await relayRpc("fs.read", { path: stripSlash(path) }, { userId: ctx.userId }) as { content: string; size: number };
    return { content: r.content, size: r.size };
  }
  const r = await platformPost<{ contentBase64: string; size: number }>(
    `/api/v1/containers/${ctx.containerId}/tools/read`,
    ctx.apiKey,
    { path: containerPath(path) },
  );
  return { content: Buffer.from(r.contentBase64, "base64").toString("utf8"), size: r.size };
}

export async function remoteWrite(ctx: RemoteSessionContext, path: string, content: string): Promise<void> {
  if (ctx.mode === "local-machine") {
    await relayRpc("fs.write", { path: stripSlash(path), content }, { userId: ctx.userId });
    return;
  }
  await platformPost(
    `/api/v1/containers/${ctx.containerId}/tools/write`,
    ctx.apiKey,
    { path: containerPath(path), content: Buffer.from(content, "utf8").toString("base64") },
  );
}

/** Create an EMPTY file or a directory (the platform write schema rejects
 *  zero-length content, so empty files go through `touch`). */
export async function remoteCreateEmpty(ctx: RemoteSessionContext, path: string, kind: "file" | "dir"): Promise<void> {
  const target = ctx.mode === "local-machine" ? stripSlash(path) : containerPath(path);
  if (ctx.mode === "local-machine") {
    if (kind === "dir") {
      await relayRpc("fs.mkdir", { path: target }, { userId: ctx.userId });
    } else {
      await relayRpc("fs.write", { path: target, content: "" }, { userId: ctx.userId });
    }
    return;
  }
  const command = kind === "dir" ? `mkdir -p -- ${shellQuote(target)}` : `mkdir -p -- $(dirname ${shellQuote(target)}) && touch -- ${shellQuote(target)}`;
  await platformPost(
    `/api/v1/containers/${ctx.containerId}/tools/bash`,
    ctx.apiKey,
    { command },
  );
}

export async function remoteDelete(ctx: RemoteSessionContext, path: string): Promise<void> {
  if (ctx.mode === "local-machine") {
    await relayRpc("fs.delete", { path: stripSlash(path) }, { userId: ctx.userId });
    return;
  }
  await platformPost(
    `/api/v1/containers/${ctx.containerId}/tools/bash`,
    ctx.apiKey,
    { command: `rm -rf -- ${shellQuote(containerPath(path))}` },
  );
}

export async function remoteRename(ctx: RemoteSessionContext, path: string, newPath: string): Promise<void> {
  if (ctx.mode === "local-machine") {
    await relayRpc("fs.rename", { from: stripSlash(path), to: stripSlash(newPath) }, { userId: ctx.userId });
    return;
  }
  await platformPost(
    `/api/v1/containers/${ctx.containerId}/tools/bash`,
    ctx.apiKey,
    { command: `mkdir -p -- $(dirname ${shellQuote(containerPath(newPath))}) && mv -- ${shellQuote(containerPath(path))} ${shellQuote(containerPath(newPath))}` },
  );
}

function stripSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Map a browser-side remote path to the container path: the virtual root
 *  ("/" or "") is the container workspace (/workspace), everything else is
 *  relative to it. Keeps the file explorer's root == the container's working
 *  directory (extension tools use the same convention). */
function containerPath(path: string): string {
  const p = stripSlash(path);
  return p ? `/workspace/${p}` : "/workspace";
}

function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}
