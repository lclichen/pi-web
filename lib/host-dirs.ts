/**
 * Host 目录注册表（"空项目"）。
 *
 * Host 模式的会话没有 projectId（SDK cwd 就是服务器目录），侧栏的 Host 组
 * 一直是"从会话 cwd 动态聚合"的虚拟分组——没有会话就没有组。这里单独记
 * 一份目录注册表，让"新建 Host 项目"能在项目-会话树里立刻看到一个空组，
 * **不改变** ProjectRecord / 会话创建 / 凭据层 / 删除语义：
 *
 *   · 只记 root（/api/cwd/validate 返回的 projectRoot，也是动态分组的 key）；
 *   · 删除记录只移除占位，绝不触碰真实目录；
 *   · 有会话时侧栏隐藏"从列表移除"（避免点了看起来没变化）。
 *
 * 与 projects.json 分开存：Host 目录不是项目，不能进 createProject /
 * projectHome / deleteProject 那条链路。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./mode-homes";
import { hostDirLabel } from "./host-groups";

export interface HostDirRecord {
  id: string;
  ownerId: number;
  /** 校验后的目录根（projectRoot），与侧栏动态分组的 key 完全一致。 */
  root: string;
  /** 显示名覆盖；缺省 = 目录末级名。 */
  name?: string;
  createdAt: number;
  updatedAt: number;
}

interface HostDirsFile {
  version: 1;
  dirs: Record<string, HostDirRecord>;
}

declare global {
  var __piHostDirsStore: { path: string; data: HostDirsFile; mtime: number } | undefined;
}

function storePath(): string {
  return join(dataDir(), "host-dirs.json");
}

/** 与 projects.json 相同的 mtime 缓存：不同路由模块实例之间保持可见。 */
function store(): { path: string; data: HostDirsFile } {
  const path = storePath();
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // missing file → mtime 0
  }
  const cached = globalThis.__piHostDirsStore;
  if (!cached || cached.path !== path || cached.mtime !== mtime) {
    let data: HostDirsFile = { version: 1, dirs: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as HostDirsFile;
      if (parsed && parsed.dirs) data = parsed;
    } catch {
      // fresh store
    }
    const next = { path, data, mtime };
    globalThis.__piHostDirsStore = next;
    return next;
  }
  return cached;
}

function persist(): void {
  const s = store();
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(s.path, JSON.stringify(s.data, null, 2) + "\n", "utf8");
  } catch {
    // best-effort sidecar
  }
}

/**
 * 归一化目录根：**保留原始分隔符**，只去尾斜杠。
 *
 * 必须与会话列表里的 `projectRoot` 逐字一致——Windows 上 `resolveProject`
 * 返回反斜杠路径（D:\…）；若这里统一转成 D:/…，注册表空组会和同目录的
 * 会话组分裂成两个组。根路径（"/"、"C:\"）原样保留。
 */
export function normalizeHostRoot(root: string): string {
  const value = root.trim();
  if (value === "/" || /^[A-Za-z]:[\\/]$/.test(value)) return value;
  return value.replace(/[\\/]+$/, "") || value;
}

/** 目录显示名：自定义名 → 末级目录名 → 原始路径。 */
export function hostDirDisplayName(record: Pick<HostDirRecord, "root" | "name">): string {
  const named = record.name?.trim();
  if (named) return named;
  return hostDirLabel(normalizeHostRoot(record.root));
}

export function listHostDirs(ownerId: number): HostDirRecord[] {
  return Object.values(store().data.dirs)
    .filter((d) => d.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getHostDirByRoot(ownerId: number, root: string): HostDirRecord | undefined {
  const target = normalizeHostRoot(root);
  return Object.values(store().data.dirs).find((d) => d.ownerId === ownerId && d.root === target);
}

/** 幂等 upsert：同一 (owner, root) 只保留一条；已有自定义名不被无参调用覆盖。 */
export function upsertHostDir(input: { ownerId: number; root: string; name?: string | null }): HostDirRecord {
  const root = normalizeHostRoot(input.root);
  const name = input.name?.trim() || undefined;
  const existing = getHostDirByRoot(input.ownerId, root);
  const now = Date.now();
  if (existing) {
    if (name) existing.name = name;
    existing.updatedAt = now;
    persist();
    return existing;
  }
  const record: HostDirRecord = {
    id: randomUUID(),
    ownerId: input.ownerId,
    root,
    ...(name ? { name } : {}),
    createdAt: now,
    updatedAt: now,
  };
  store().data.dirs[record.id] = record;
  persist();
  return record;
}

export function renameHostDir(
  id: string,
  ownerId: number,
  name: string,
): { ok: true; dir: HostDirRecord } | { ok: false; error: string } {
  const record = store().data.dirs[id];
  if (!record || record.ownerId !== ownerId) return { ok: false, error: "目录记录不存在" };
  const trimmed = name.trim();
  if (trimmed.length > 64) return { ok: false, error: "名称不能超过 64 字符" };
  if (trimmed) record.name = trimmed;
  else delete record.name;
  record.updatedAt = Date.now();
  persist();
  return { ok: true, dir: record };
}

/** 只删占位记录，绝不触碰真实目录。 */
export function removeHostDir(id: string, ownerId: number): boolean {
  const record = store().data.dirs[id];
  if (!record || record.ownerId !== ownerId) return false;
  delete store().data.dirs[id];
  persist();
  return true;
}

/** 目录是否仍存在（侧栏可据此提示，不自动清理记录）。 */
export function hostDirExists(record: Pick<HostDirRecord, "root">): boolean {
  try {
    return existsSync(record.root) && statSync(record.root).isDirectory();
  } catch {
    return false;
  }
}
