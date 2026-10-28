import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./mode-homes";
import { getProject } from "./projects";
import type { SessionMode } from "./session-modes";

/**
 * Sidecar metadata for sessions created through pi-web: execution mode and
 * owning user. The pi session files themselves carry neither, and the
 * in-memory registry only covers live sessions — this store fills the gap
 * for list rendering after reloads. Registry entries win when both exist.
 */

export interface SessionMeta {
  mode: SessionMode;
  ownerId: number;
  /** Owning project (project-scoped sessions). */
  projectId?: string;
  /** Quick sessions: the per-session workspace slug (lib/quick-session.ts). */
  quickDir?: string;
  /** Quick sessions: the template that shaped the prompt/toolset (restore 用). */
  templateId?: string;
  /** 提示词一致性钉住值（lib/prompt-consistency.ts）：首回合合成提示词的
   *  哈希——恢复后首回合比对，不符即告警（前缀缓存打断可观测）。 */
  promptPin?: { hash: string; len: number; tools: number };
  ownerName?: string;
  createdAt?: number;
}

interface MetaFile {
  version: 1;
  sessions: Record<string, SessionMeta>;
}

declare global {
  // eslint-disable-next-line no-var
  var __piSessionMetas: { path: string; data: MetaFile; mtime: number } | undefined;
}

// The cache reloads when the file's mtime moves — route modules can hold
// separate module instances (per-bundle), so a write through one instance
// must be visible to reads through another. Without this, remotefs /
// remoteterminal resolved freshly-created sessions as "host" mode.
function store(): { path: string; data: MetaFile } {
  const path = metaFilePath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // missing file → mtime 0
  }
  const cached = globalThis.__piSessionMetas;
  if (!cached || cached.path !== path || cached.mtime !== mtime) {
    let data: MetaFile = { version: 1, sessions: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as MetaFile;
      if (parsed && parsed.sessions) data = parsed;
    } catch {
      // fresh store
    }
    const next = { path, data, mtime };
    globalThis.__piSessionMetas = next;
    return next;
  }
  return cached;
}

function metaFilePath(): string {
  return join(dataDir(), "session-metas.json");
}

export function recordSessionMeta(sessionId: string, meta: SessionMeta): void {
  const s = store();
  s.data.sessions[sessionId] = { ...meta, createdAt: meta.createdAt ?? Date.now() };
  try {
    writeFileSync(s.path, JSON.stringify(s.data, null, 2), "utf8");
  } catch {
    // metadata is best-effort
  }
}

export function getSessionMetas(): Record<string, SessionMeta> {
  return store().data.sessions;
}

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  return store().data.sessions[sessionId];
}

/** Sessions a user may see in listings: their own plus (admin) host-space ones. */
export function metaVisibleTo(
  meta: SessionMeta | undefined,
  ownerId: number,
  role: "admin" | "user",
  viewingHostSpace: boolean,
): boolean {
  if (!meta) return viewingHostSpace || role === "admin"; // unknown provenance: only host/admin view
  if (viewingHostSpace) return role === "admin" || meta.ownerId === ownerId;
  return meta.ownerId === ownerId;
}

/**
 * 会话模式解析：注册表（live）之外，项目记录的模式**高于**过期 sidecar
 * meta——项目从 local 迁到 host 等场景下，旧 meta 记录的 mode 会把会话
 * 误标成 host（文件面板/终端因此路由到 host 后端）。
 * getProject 用静态导入：此前曾在函数内 require("./projects")，webpack
 * 服务端打包后跨 chunk 解析拿到残缺模块，运行时抛 "X is not a
 * function"，把所有带 projectId 会话的 remotefs/remoteterminal 一起炸成
 * 空响应体 500。require 的类型断言还会绕过 tsc 检查——静态导入两端都
 * 安全（projects.ts 不回依赖本模块，无循环）。
 */
export function resolveSessionMode(sessionId: string): SessionMeta | undefined {
  const meta = getSessionMeta(sessionId);
  if (!meta) return undefined;
  if (meta.projectId) {
    const mode = getProject(meta.projectId)?.mode;
    if (mode && mode !== meta.mode) return { ...meta, mode };
  }
  return meta;
}

/**
 * 遗留孤儿推断：metas 机制建立（pre-project 时代，约 2026-08）之前创建的
 * 沙箱会话没有任何 mode 记录——列表的"无 meta 默认 Host"会把它们塞进
 * 管理员 Host 目录组（分组名是 sandbox-homes 路径，徽标语义互相矛盾，
 * 见 1ab1290b 的同类修复）。cwd 落在 <dataDir>/sandbox-homes/u<id>/ 下
 * 足以判定为沙箱会话，仅供列表展示层兜底。
 */
export function inferLegacyModeFromCwd(cwd: string | undefined | null): "sandbox" | null {
  if (!cwd) return null;
  const normalized = cwd.replace(/\\/g, "/");
  return /\/sandbox-homes\/u\d+\//.test(normalized) ? "sandbox" : null;
}
