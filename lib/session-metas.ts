import { getProject } from "./projects";
import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";
import { descriptorFromMeta, descriptorToLegacyMode } from "./session-descriptor";
import type { SessionDescriptor } from "./session-descriptor";
import type { SessionMode } from "./session-modes";

/**
 * Sidecar metadata for sessions created through pi-web: execution mode and
 * owning user. The pi session files themselves carry neither, and the
 * in-memory registry only covers live sessions — this store fills the gap
 * for list rendering after reloads. Registry entries win when both exist.
 */

export interface SessionMeta {
  /** Legacy execution mode projection; descriptor is authoritative when present. */
  mode: SessionMode;
  /** Canonical management/execution/workspace description. */
  descriptor?: SessionDescriptor;
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
  /** Embedded product session archive (hidden from embed session lists). */
  archivedAt?: number;
}

interface MetaData {
  sessions: Record<string, SessionMeta>;
}

const metasStore = new JsonStore<MetaData>({
  name: "session-metas",
  scope: { kind: "global" },
  legacyPaths: () => [legacyDataPath("session-metas.json")],
  defaults: () => ({ sessions: {} }),
  // /api/sessions calls getSessionMeta once per listed session; a short stat
  // TTL keeps that list from becoming hundreds of statSync calls.
  statTtlMs: 50,
  parse: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const sessions = (value as { sessions?: unknown }).sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return null;
    return { sessions: sessions as Record<string, SessionMeta> };
  },
});

export function recordSessionMeta(sessionId: string, meta: SessionMeta): void {
  const mode = meta.descriptor ? descriptorToLegacyMode(meta.descriptor) : meta.mode;
  metasStore.update((data) => {
    data.sessions[sessionId] = { ...meta, mode, createdAt: meta.createdAt ?? Date.now() };
  });
}

/**
 * Branch/fork/clone inherit the source session's execution contract. Without
 * this, a forked sandbox/quick session loses projectId/quickDir and restores
 * as a Host-local session.
 */
export function copySessionMeta(sourceSessionId: string, targetSessionId: string): boolean {
  const source = getSessionMeta(sourceSessionId);
  if (!source) return false;
  recordSessionMeta(targetSessionId, {
    ...source,
    ...(source.descriptor
      ? { descriptor: { ...source.descriptor, cwd: source.descriptor.cwd } }
      : {}),
    createdAt: Date.now(),
    archivedAt: undefined,
  });
  return true;
}

/** Archive/unarchive a project-bound session (embedded product session list). */
export function setSessionArchived(sessionId: string, archived: boolean): boolean {
  let found = false;
  metasStore.update((data) => {
    const meta = data.sessions[sessionId];
    if (!meta) return;
    found = true;
    if (archived) meta.archivedAt = Date.now();
    else delete meta.archivedAt;
  });
  return found;
}

/** Test seam retained for callers; writes are synchronous now. */
export function flushSessionMetasForTests(): void {}

export function getSessionMetas(): Record<string, SessionMeta> {
  return metasStore.read().sessions;
}

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  return metasStore.read().sessions[sessionId];
}

export function deleteSessionMeta(sessionId: string): boolean {
  let removed = false;
  metasStore.update((data) => {
    if (!data.sessions[sessionId]) return;
    delete data.sessions[sessionId];
    removed = true;
  });
  return removed;
}

export function deleteSessionMetasForProject(projectId: string): string[] {
  const removed: string[] = [];
  metasStore.update((data) => {
    for (const [sessionId, meta] of Object.entries(data.sessions)) {
      if (meta.projectId !== projectId) continue;
      delete data.sessions[sessionId];
      removed.push(sessionId);
    }
  });
  return removed;
}

/** User deletion: drop orphan session sidecars not covered by a project cascade. */
export function deleteSessionMetasForOwner(ownerId: number): string[] {
  const removed: string[] = [];
  metasStore.update((data) => {
    for (const [sessionId, meta] of Object.entries(data.sessions)) {
      if (meta.ownerId !== ownerId) continue;
      delete data.sessions[sessionId];
      removed.push(sessionId);
    }
  });
  return removed;
}

/** Other sessions sharing a Quick workspace version (don't delete it under them). */
export function sessionIdsUsingQuickDir(ownerId: number, quickDir: string, except?: string): string[] {
  return Object.entries(metasStore.read().sessions)
    .filter(
      ([sessionId, meta]) =>
        sessionId !== except &&
        meta.ownerId === ownerId &&
        meta.mode === "quick" &&
        meta.quickDir === quickDir,
    )
    .map(([sessionId]) => sessionId);
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
  const descriptor = descriptorFromMeta(meta);
  if (descriptor) {
    const mode = descriptorToLegacyMode(descriptor);
    if (mode !== meta.mode) return { ...meta, mode, descriptor };
  }
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
