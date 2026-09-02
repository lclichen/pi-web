import { getRpcSessionOwner } from "./rpc-manager";
import { getSessionMeta } from "./session-metas";
import { requireUserIdentity } from "./web-session";
import { getAgentForUser } from "./relay/registry";
import { platformGet, platformPost } from "./platform/client";
import { readSandboxHomeConfig } from "./mode-homes";
import { ensureProjectHome, getOwnedProject, readProjectSandboxConfig } from "./projects";
import { getSshClient, readSshConfig, type SshConfig } from "./ssh";
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
  /** SSH mode: owning project + remote workdir base. */
  projectId?: string;
  workdir?: string;
  sshConfig?: import("./ssh").SshConfig;
  /** Server-side project home — absolute UI paths under it map to the workdir. */
  homePrefix?: string;
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

  if (mode === "ssh") {
    // SSH 会话必然绑定项目：meta.projectId 提供凭据与远程工作目录。
    const project = meta?.projectId && (user.role === "admin" || meta.ownerId === user.id || user.id === 0)
      ? getOwnedProject(meta.projectId, meta.ownerId ?? user.id, user.role === "admin")
      : undefined;
    if (!project || project.mode !== "ssh") {
      return { ok: false, status: 400, error: "SSH 会话缺少项目绑定" };
    }
    const home = ensureProjectHome(project);
    const sshConfig = readSshConfig(home);
    if (!sshConfig) return { ok: false, status: 400, error: "SSH 项目缺少连接配置" };
    return { ok: true, ctx: { mode: "ssh", userId: user.id, apiKey: "", containerId: 0, isAdmin: user.role === "admin", projectId: project.id, workdir: project.workdir ?? "/", homePrefix: home, sshConfig } };
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

// ---- SSH (ssh 模式)：虚拟根 = 远程工作目录 ----

function sshPath(ctx: RemoteSessionContext, path: string): string {
  const wd = (ctx.workdir ?? "/").replace(/\/+$/, "");
  let p = path.startsWith("/") ? path : "/" + path;
  // 项目 home 前缀（服务器侧绝对路径，如 plan 文件）映射到远程工作目录，
  // 与 Agent 工具的相对路径语义保持一致。
  const home = ctx.homePrefix?.replace(/\/+$/, "");
  if (home && (p === home || p.startsWith(home + "/"))) p = p.slice(home.length) || "/";
  return wd + p;
}

async function sshClientFor(ctx: RemoteSessionContext) {
  if (!ctx.projectId || !ctx.sshConfig) throw new Error("SSH 会话缺少连接配置");
  return getSshClient(ctx.projectId, ctx.sshConfig);
}

interface SftpListEntry { filename: string; attrs: { isDirectory(): boolean; size: number } }

function sftpOf(client: unknown): Promise<{
  readdir(p: string, cb: (e: Error | undefined, l: SftpListEntry[]) => void): void;
  readFile(p: string, cb: (e: Error | undefined, d: Buffer) => void): void;
  writeFile(p: string, c: string, cb: (e: Error | undefined) => void): void;
  mkdir(p: string, o: { recursive: true }, cb: (e: Error | undefined) => void): void;
}> {
  return new Promise((resolve, reject) => {
    (client as { sftp(cb: (e: Error | undefined, s: unknown) => void): void }).sftp((e, s) =>
      e ? reject(e) : resolve(s as Parameters<typeof resolve>[0]));
  });
}

async function sshRun(ctx: RemoteSessionContext, command: string): Promise<void> {
  const client = await sshClientFor(ctx);
  await new Promise<void>((resolve, reject) => {
    client.exec(command, (err: Error | undefined, stream: { on(ev: "close", cb: (c: number) => void): void; stderr: { on(ev: "data", cb: (d: Buffer) => void): void } }) => {
      if (err) return reject(err);
      let stderr = "";
      stream.stderr.on("data", (d) => { stderr += d.toString(); });
      stream.on("close", (code) => {
        if (code !== 0) reject(new Error(`远程命令失败（exit ${code}）：${stderr.trim().slice(0, 200)}`));
        else resolve();
      });
    });
  });
}
export async function remoteList(ctx: RemoteSessionContext, path: string): Promise<RemoteEntry[]> {
  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    const s = await sftpOf(client);
    const list = await new Promise<SftpListEntry[]>((resolve, reject) => s.readdir(sshPath(ctx, path), (e, l) => e ? reject(e) : resolve(l)));
    return list.map((e) => ({ name: e.filename, isDir: e.attrs.isDirectory(), size: e.attrs.size, modified: "" }));
  }
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
  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    const s = await sftpOf(client);
    const buf = await new Promise<Buffer>((resolve, reject) => s.readFile(sshPath(ctx, path), (e, d) => e ? reject(e) : resolve(d)));
    return { content: buf.toString("utf8"), size: buf.length };
  }
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
  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    const s = await sftpOf(client);
    await new Promise<void>((resolve, reject) => s.writeFile(sshPath(ctx, path), content, (e) => e ? reject(e) : resolve()));
    return;
  }
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
  if (ctx.mode === "ssh") {
    const target = sshPath(ctx, path);
    const q = (t: string) => t.replace(/'/g, "'\\''");
    if (kind === "dir") await sshRun(ctx, `mkdir -p -- '${q(target)}'`);
    else await sshRun(ctx, `mkdir -p -- $(dirname '${q(target)}') && touch -- '${q(target)}'`);
    return;
  }
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
  if (ctx.mode === "ssh") {
    const q = (t: string) => t.replace(/'/g, "'\\''");
    await sshRun(ctx, `rm -rf -- '${q(sshPath(ctx, path))}'`);
    return;
  }
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
  if (ctx.mode === "ssh") {
    const q = (t: string) => t.replace(/'/g, "'\\''");
    await sshRun(ctx, `mkdir -p -- $(dirname '${q(sshPath(ctx, newPath))}') && mv -- '${q(sshPath(ctx, path))}' '${q(sshPath(ctx, newPath))}'`);
    return;
  }
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
