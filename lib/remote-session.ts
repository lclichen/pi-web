import { getRpcSessionOwner } from "./rpc-manager";
import { resolveSessionMode } from "./session-metas";
import { requireUserIdentity } from "./web-session";
import { getAgentForUser } from "./relay/registry";
import { platformGet, platformPost } from "./platform/client";
import { readSandboxHomeConfig } from "./mode-homes";
import { ensureProjectHome, getOwnedProject, readProjectSandboxConfig } from "./projects";
import { getSshClient, readSshConfig, type SshConfig } from "./ssh";
import { relayRpc } from "./relay/forward";
import { requireCompatibleAgent } from "./relay/agent-gate";
import {
  agentSupportsBinaryRead,
  resolveRelayWorkspaceScope,
  toRelayPath,
  type RelayWorkspaceScope,
} from "./relay/workspace-base";
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
  /** SSH mode: owning project id. */
  projectId?: string;
  /** SSH mode: remote workdir base. Local-machine mode: the project's
   *  workspace directory on the user's machine (the file panel's UI root). */
  workdir?: string;
  sshConfig?: import("./ssh").SshConfig;
  /** Server-side project home — absolute UI paths under it map to the workdir. */
  homePrefix?: string;
  /** Local-machine mode: the paired machine this session's project targets
   *  (absent = the user's default machine). */
  machineId?: string;
}

interface PlatformContainer {
  id: number;
  status: string;
}

export async function resolveRemoteSession(
  req: Request,
  sessionId: string,
): Promise<{ ok: true; ctx: RemoteSessionContext } | { ok: false; status: number; error: string }> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: identity.status, error: "登录已失效" };
  const { user } = identity.session;

  // Registry first (live), sidecar metas second (reloaded sessions).
  const owner = getRpcSessionOwner(sessionId);
  const meta = resolveSessionMode(sessionId);
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
    const project =
      meta?.projectId && (user.role === "admin" || meta.ownerId === user.id || user.id === 0)
        ? getOwnedProject(meta.projectId, meta.ownerId ?? user.id, user.role === "admin")
        : undefined;
    if (!project || project.mode !== "ssh") {
      return { ok: false, status: 400, error: "SSH 会话缺少项目绑定" };
    }
    const home = ensureProjectHome(project);
    const sshConfig = readSshConfig(home);
    if (!sshConfig) return { ok: false, status: 400, error: "SSH 项目缺少连接配置" };
    return {
      ok: true,
      ctx: {
        mode: "ssh",
        userId: user.id,
        apiKey: "",
        containerId: 0,
        isAdmin: user.role === "admin",
        projectId: project.id,
        workdir: project.workdir ?? "/",
        homePrefix: home,
        sshConfig,
      },
    };
  }

  if (mode === "local-machine") {
    // Project binding wins: a local-machine project may pin one specific
    // machine (multi-machine support) and a workspace directory (project
    // workdir) that becomes the file panel's virtual root. Sessions without a
    // project binding use the user's default (most recent) machine + its root.
    let machineId: string | undefined;
    let workdir: string | undefined;
    if (meta?.projectId && (user.role === "admin" || meta.ownerId === user.id || user.id === 0)) {
      const project = getOwnedProject(meta.projectId, meta.ownerId ?? user.id, user.role === "admin");
      if (project && project.mode === "local-machine") {
        if (project.machineId) machineId = project.machineId;
        if (project.workdir) workdir = project.workdir;
      }
    }
    // Online + version check (outdated clients fail with an upgrade message
    // instead of silently running file operations in the wrong root).
    const gate = requireCompatibleAgent(user.id, machineId);
    if (!gate.ok) return { ok: false, status: gate.status, error: gate.error };
    // Fail early with an actionable message when the bound workspace cannot be
    // reached by this agent (legacy agent + directory outside its shared root).
    if (workdir) {
      const scope = resolveRelayWorkspaceScope(workdir, gate.info);
      if (scope.error) return { ok: false, status: 409, error: scope.error };
    }
    return {
      ok: true,
      ctx: {
        mode,
        userId: user.id,
        apiKey: "",
        containerId: 0,
        isAdmin: user.role === "admin",
        machineId: gate.machineId,
        ...(workdir ? { workdir } : {}),
      },
    };
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
  return {
    ok: true,
    ctx: { mode, userId: user.id, apiKey: identity.session.apiKey, containerId, isAdmin: user.role === "admin" },
  };
}

// ---- backend helpers ----

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

// ---- SSH (ssh 模式)：虚拟根 = 远程工作目录 ----

/** Exported for tests only — path mapping is pure. */
export function sshPath(ctx: RemoteSessionContext, path: string): string {
  const wd = (ctx.workdir ?? "/").replace(/\/+$/, "");
  let p = path.startsWith("/") ? path : "/" + path;
  // 项目 home 前缀（服务器侧绝对路径，如 plan 文件）映射到远程工作目录，
  // 与 Agent 工具的相对路径语义保持一致。
  const home = ctx.homePrefix?.replace(/\/+$/, "");
  if (home && (p === home || p.startsWith(home + "/"))) p = p.slice(home.length) || "/";
  // 会话收尾/聊天链接给出的是远程绝对路径（已含工作目录前缀）——先剥掉
  // 再拼，否则会得到 /wd/wd/file 的双重路径（stat no such file）。
  if (wd && wd !== "/" && (p === wd || p.startsWith(wd + "/"))) p = p.slice(wd.length) || "/";
  if (p === "/") return wd || "/";
  return `${wd}${p}`.replace(/\/+$/, "") || "/";
}

async function sshClientFor(ctx: RemoteSessionContext) {
  if (!ctx.projectId || !ctx.sshConfig) throw new Error("SSH 会话缺少连接配置");
  return getSshClient(ctx.projectId, ctx.sshConfig);
}

interface SftpListEntry {
  filename: string;
  attrs: { isDirectory(): boolean; size: number };
}

function sftpOf(client: unknown): Promise<{
  readdir(p: string, cb: (e: Error | undefined, l: SftpListEntry[]) => void): void;
  readFile(p: string, cb: (e: Error | undefined, d: Buffer) => void): void;
  writeFile(p: string, c: string, cb: (e: Error | undefined) => void): void;
  mkdir(p: string, o: { recursive: true }, cb: (e: Error | undefined) => void): void;
}> {
  return new Promise((resolve, reject) => {
    (client as { sftp(cb: (e: Error | undefined, s: unknown) => void): void }).sftp((e, s) =>
      e ? reject(e) : resolve(s as Parameters<typeof resolve>[0]),
    );
  });
}

async function sshRun(ctx: RemoteSessionContext, command: string): Promise<void> {
  const client = await sshClientFor(ctx);
  await new Promise<void>((resolve, reject) => {
    client.exec(
      command,
      (
        err: Error | undefined,
        stream: {
          on(ev: "close", cb: (c: number) => void): void;
          stderr: { on(ev: "data", cb: (d: Buffer) => void): void };
        },
      ) => {
        if (err) return reject(err);
        let stderr = "";
        stream.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        stream.on("close", (code) => {
          if (code !== 0) reject(new Error(`远程命令失败（exit ${code}）：${stderr.trim().slice(0, 200)}`));
          else resolve();
        });
      },
    );
  });
}
/** Local-machine backend helpers: every relay call carries the project
 *  workspace (`base` for agent >= 0.2.0, root-relative prefix otherwise) and
 *  every UI path is mapped into that workspace. */
export function localScope(ctx: RemoteSessionContext): RelayWorkspaceScope {
  const gate = requireCompatibleAgent(ctx.userId, ctx.machineId);
  if (!gate.ok) throw new Error(gate.error);
  const scope = resolveRelayWorkspaceScope(ctx.workdir, gate.info);
  if (scope.error) throw new Error(scope.error);
  return scope;
}

function localRelay<T>(
  ctx: RemoteSessionContext,
  method: Parameters<typeof relayRpc>[0],
  params: Record<string, unknown>,
  scope: RelayWorkspaceScope,
): Promise<T> {
  return relayRpc(
    method,
    { ...params, ...(scope.base ? { base: scope.base } : {}) },
    { userId: ctx.userId, machineId: ctx.machineId },
  ) as Promise<T>;
}

/** Map a file-panel path (relative to the workspace root, "/" = root) onto
 *  the relay wire path used by the agent.
 *
 *  Absolute inputs that already carry the workspace prefix (chat file links /
 *  turn-written paths echo the absolute workdir) are unwrapped first; without
 *  this the leading slash was stripped and the remainder re-prefixed by the
 *  agent, producing the doubled <base>/<base>/file stat error. Absolute paths
 *  OUTSIDE the workspace keep the historical virtual-root semantics ("/x" =
 *  workspace root + x). With no workdir bound, a true absolute passes through
 *  verbatim (the agent resolves and fences it at its shared root). */
/** Exported for tests only — path mapping is pure. */
export function localWirePath(ctx: RemoteSessionContext, path: string, scope: RelayWorkspaceScope): string {
  const raw = path.trim();
  if (raw.startsWith("/")) {
    const rel = ctx.workdir ? absoluteRelativeToRoot(raw, ctx.workdir) : null;
    if (rel !== null) return toRelayPath(rel === "" ? "." : rel, scope, ctx.workdir) || ".";
    if (!ctx.workdir) return toRelayPath(raw, scope, ctx.workdir) || ".";
  }
  return toRelayPath(stripSlash(raw), scope, ctx.workdir) || ".";
}

/** Lexical `path` relative to `root` when the absolute path sits under it
 *  ("" = the root itself); null otherwise. POSIX-style only — Windows drive
 *  absolutes are handled inside toRelayPath already. */
function absoluteRelativeToRoot(path: string, root: string): string | null {
  const p = path.replace(/\/+$/, "");
  const b = root.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (!b.startsWith("/")) return null;
  if (p === b) return "";
  if (p.startsWith(b + "/")) return p.slice(b.length + 1);
  return null;
}

export async function remoteList(ctx: RemoteSessionContext, path: string): Promise<RemoteEntry[]> {
  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    const s = await sftpOf(client);
    const list = await new Promise<SftpListEntry[]>((resolve, reject) =>
      s.readdir(sshPath(ctx, path), (e, l) => (e ? reject(e) : resolve(l))),
    );
    return list.map((e) => ({ name: e.filename, isDir: e.attrs.isDirectory(), size: e.attrs.size, modified: "" }));
  }
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    const entries = await localRelay<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>(
      ctx,
      "fs.list",
      { path: localWirePath(ctx, path, scope) },
      scope,
    );
    return entries.map((e) => ({
      name: e.name,
      isDir: e.isDir,
      size: e.size,
      modified: new Date(e.mtime).toISOString(),
    }));
  }
  const res = await platformGet<{
    entries?: Array<{ name: string; isDirectory?: boolean; isDir?: boolean; size?: number; mtimeMs?: number }>;
  }>(`/api/v1/containers/${ctx.containerId}/tools/ls`, ctx.apiKey, { path: containerPath(path) });
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
    const buf = await new Promise<Buffer>((resolve, reject) =>
      s.readFile(sshPath(ctx, path), (e, d) => (e ? reject(e) : resolve(d))),
    );
    return { content: buf.toString("utf8"), size: buf.length };
  }
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    const r = await localRelay<{ content: string; size: number }>(
      ctx,
      "fs.read",
      { path: localWirePath(ctx, path, scope) },
      scope,
    );
    return { content: r.content, size: r.size };
  }
  const r = await platformPost<{ contentBase64: string; size: number }>(
    `/api/v1/containers/${ctx.containerId}/tools/read`,
    ctx.apiKey,
    { path: containerPath(path) },
  );
  return { content: Buffer.from(r.contentBase64, "base64").toString("utf8"), size: r.size };
}

/**
 * Binary-safe read for media/document previews (images, audio, video, PDF).
 *
 * /api/files streams raw bytes with the right content-type; the remote panel
 * used to funnel everything through the JSON text read, which cannot carry
 * arbitrary bytes (invalid UTF-8 becomes U+FFFD) — remote images rendered as
 * broken boxes. Each backend has a binary-capable path:
 *   · sandbox  — platform tools/read already returns base64
 *   · ssh      — sftp.readFile returns a Buffer
 *   · local-machine — relay fs.read with encoding:"base64" (agent >= 0.2.x,
 *     advertised as the "binary-read" feature); older agents fall back to a
 *     `base64 -w0` exec, and when that is unavailable the caller gets an
 *     upgrade hint instead of silently corrupted bytes.
 */
export async function remoteReadBinary(
  ctx: RemoteSessionContext,
  path: string,
): Promise<{ bytes: Buffer; size: number }> {
  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    const s = await sftpOf(client);
    const buf = await new Promise<Buffer>((resolve, reject) =>
      s.readFile(sshPath(ctx, path), (e, d) => (e ? reject(e) : resolve(d))),
    );
    return { bytes: buf, size: buf.length };
  }
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    const wire = localWirePath(ctx, path, scope);
    const gate = requireCompatibleAgent(ctx.userId, ctx.machineId);
    if (!gate.ok) throw new Error(gate.error);
    if (agentSupportsBinaryRead(gate.info)) {
      const r = await localRelay<{ contentBase64?: string; size: number }>(
        ctx,
        "fs.read",
        { path: wire, encoding: "base64" },
        scope,
      );
      if (typeof r.contentBase64 !== "string") throw new Error("本机 Agent 未返回二进制内容");
      const bytes = Buffer.from(r.contentBase64, "base64");
      return { bytes, size: bytes.length };
    }
    // Pre-binary-read agent: base64 has been part of coreutils forever; for
    // Windows agents without it the error below is actionable.
    try {
      const r = await localRelay<{ stdout?: string; stderr?: string; exitCode?: number }>(
        ctx,
        "exec.run",
        { argv: ["base64", "-w0", "--", wire === "." ? "." : wire], cwd: "." },
        scope,
      );
      if (r.exitCode === 0 && typeof r.stdout === "string" && r.stdout.trim()) {
        const bytes = Buffer.from(r.stdout.trim(), "base64");
        return { bytes, size: bytes.length };
      }
      throw new Error((r.stderr ?? "").trim() || "base64 读取失败");
    } catch {
      throw new Error("本机 Agent 版本过旧，无法读取二进制文件（请升级 Agent 到 0.2.0+）");
    }
  }
  const r = await platformPost<{ contentBase64: string; size: number }>(
    `/api/v1/containers/${ctx.containerId}/tools/read`,
    ctx.apiKey,
    { path: containerPath(path) },
  );
  const bytes = Buffer.from(r.contentBase64, "base64");
  return { bytes, size: bytes.length };
}

export async function remoteWrite(ctx: RemoteSessionContext, path: string, content: string): Promise<void> {
  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    const s = await sftpOf(client);
    await new Promise<void>((resolve, reject) =>
      s.writeFile(sshPath(ctx, path), content, (e) => (e ? reject(e) : resolve())),
    );
    return;
  }
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    await localRelay(ctx, "fs.write", { path: localWirePath(ctx, path, scope), content }, scope);
    return;
  }
  await platformPost(`/api/v1/containers/${ctx.containerId}/tools/write`, ctx.apiKey, {
    path: containerPath(path),
    content: Buffer.from(content, "utf8").toString("base64"),
  });
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
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    const target = localWirePath(ctx, path, scope);
    if (kind === "dir") {
      await localRelay(ctx, "fs.mkdir", { path: target }, scope);
    } else {
      await localRelay(ctx, "fs.write", { path: target, content: "" }, scope);
    }
    return;
  }
  const target = containerPath(path);
  const command =
    kind === "dir"
      ? `mkdir -p -- ${shellQuote(target)}`
      : `mkdir -p -- $(dirname ${shellQuote(target)}) && touch -- ${shellQuote(target)}`;
  await platformPost(`/api/v1/containers/${ctx.containerId}/tools/bash`, ctx.apiKey, { command });
}

export async function remoteDelete(ctx: RemoteSessionContext, path: string): Promise<void> {
  if (ctx.mode === "ssh") {
    const q = (t: string) => t.replace(/'/g, "'\\''");
    await sshRun(ctx, `rm -rf -- '${q(sshPath(ctx, path))}'`);
    return;
  }
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    await localRelay(ctx, "fs.delete", { path: localWirePath(ctx, path, scope) }, scope);
    return;
  }
  await platformPost(`/api/v1/containers/${ctx.containerId}/tools/bash`, ctx.apiKey, {
    command: `rm -rf -- ${shellQuote(containerPath(path))}`,
  });
}

export async function remoteRename(ctx: RemoteSessionContext, path: string, newPath: string): Promise<void> {
  if (ctx.mode === "ssh") {
    const q = (t: string) => t.replace(/'/g, "'\\''");
    await sshRun(
      ctx,
      `mkdir -p -- $(dirname '${q(sshPath(ctx, newPath))}') && mv -- '${q(sshPath(ctx, path))}' '${q(sshPath(ctx, newPath))}'`,
    );
    return;
  }
  if (ctx.mode === "local-machine") {
    const scope = localScope(ctx);
    await localRelay(
      ctx,
      "fs.rename",
      {
        from: localWirePath(ctx, path, scope),
        to: localWirePath(ctx, newPath, scope),
      },
      scope,
    );
    return;
  }
  await platformPost(`/api/v1/containers/${ctx.containerId}/tools/bash`, ctx.apiKey, {
    command: `mkdir -p -- $(dirname ${shellQuote(containerPath(newPath))}) && mv -- ${shellQuote(containerPath(path))} ${shellQuote(containerPath(newPath))}`,
  });
}

function stripSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Map a browser-side remote path to the container path: the virtual root
 *  ("/" or "") is the container workspace (/workspace), everything else is
 *  relative to it. Keeps the file explorer's root == the container's working
 *  directory (extension tools use the same convention). */
/** Exported for tests only — path mapping is pure. */
export function containerPath(path: string): string {
  let p = stripSlash(path);
  // Container-absolute inputs (chat links echo /workspace/…) already carry the
  // prefix — unwrap instead of doubling it to /workspace/workspace/…
  if (p === "workspace") return "/workspace";
  if (p.startsWith("workspace/")) p = p.slice("workspace/".length);
  return p ? `/workspace/${p}` : "/workspace";
}

function shellQuote(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/** Bounded filename search across all three remote modes — the remotefs
 *  counterpart of the host /api/file-index. Matches are case-insensitive
 *  substrings over file basenames, files only, capped at 200 hits, returned
 *  as paths RELATIVE to the search base (same shape as the host index). */
export async function remoteFind(ctx: RemoteSessionContext, base: string, query: string): Promise<string[]> {
  const MAX = 200;
  // grep pattern is single-quoted; the query itself cannot contain quotes after
  // escaping, keeping the composed command injection-safe alongside shellQuote.
  const grepPat = query.replace(/'/g, "");
  if (!grepPat) return [];
  const findCmd = (root: string) =>
    `find ${shellQuote(root)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | grep -i ${shellQuote(grepPat)} | head -${MAX}`;

  if (ctx.mode === "ssh") {
    const client = await sshClientFor(ctx);
    // Run inside the remote workdir with RELATIVE output so the UI gets
    // workdir-relative paths exactly like the other SSH tools.
    const wd = (ctx.workdir ?? "/").replace(/\/+$/, "");
    const q = (t: string) => t.replace(/'/g, "'\\''");
    const r = await new Promise<string>((resolve, reject) => {
      client.exec(
        `cd '${q(wd)}' 2>/dev/null || cd /; { find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | grep -i '${grepPat}' | head -${MAX}; }`,
        (
          err: Error | undefined,
          stream: {
            on(ev: "close", cb: (c: number) => void): void;
            on(ev: "data", cb: (d: Buffer) => void): void;
            stderr: { on(ev: "data", cb: (d: Buffer) => void): void };
          },
        ) => {
          if (err) return reject(err);
          let out = "";
          let stderr = "";
          stream.on("data", (d) => {
            out += d.toString();
          });
          stream.stderr.on("data", (d) => {
            stderr += d.toString();
          });
          stream.on("close", (code) => {
            if (code !== 0 && code !== 1)
              reject(new Error(`Remote find failed (exit ${code}): ${stderr.trim().slice(0, 200)}`));
            else resolve(out);
          });
        },
      );
    });
    return r
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => p.replace(/^\.\//, ""));
  }

  if (ctx.mode === "local-machine") {
    // relay exec.run is argv-based (no shell) — wrap with bash -c like relay-tools.
    const scope = localScope(ctx);
    const wireBase = localWirePath(ctx, base, scope);
    const r = await localRelay<{ stdout?: string }>(
      ctx,
      "exec.run",
      {
        argv: ["bash", "-c", findCmd(wireBase === "." ? "." : wireBase)],
        cwd: ".",
      },
      scope,
    );
    const strip = wireBase === "." ? "" : `${wireBase.replace(/\/+$/, "")}/`;
    return (r.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => {
        const clean = p.replace(/^\.\//, "");
        return strip && clean.startsWith(strip) ? clean.slice(strip.length) : clean;
      });
  }

  const root = containerPath(base);
  const res = await platformPost<{ stdout?: string; stderr?: string; exitCode?: number }>(
    `/api/v1/containers/${ctx.containerId}/tools/bash`,
    ctx.apiKey,
    { command: `${findCmd(root)} | sed 's|^${root}/||'` },
  );
  return (res.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
