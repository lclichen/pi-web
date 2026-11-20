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
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";
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

interface HostDirData {
  dirs: Record<string, HostDirRecord>;
}

const hostDirsStore = new JsonStore<HostDirData>({
  name: "host-dirs",
  scope: { kind: "global" },
  legacyPaths: () => [legacyDataPath("host-dirs.json")],
  defaults: () => ({ dirs: {} }),
  parse: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const dirs = (value as { dirs?: unknown }).dirs;
    if (!dirs || typeof dirs !== "object" || Array.isArray(dirs)) return null;
    return { dirs: dirs as Record<string, HostDirRecord> };
  },
});

function hostDirData(): HostDirData {
  return hostDirsStore.read();
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
  return Object.values(hostDirData().dirs)
    .filter((d) => d.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getHostDirByRoot(ownerId: number, root: string): HostDirRecord | undefined {
  const target = normalizeHostRoot(root);
  return Object.values(hostDirData().dirs).find((d) => d.ownerId === ownerId && d.root === target);
}

/** 幂等 upsert：同一 (owner, root) 只保留一条；已有自定义名不被无参调用覆盖。 */
export function upsertHostDir(input: { ownerId: number; root: string; name?: string | null }): HostDirRecord {
  const root = normalizeHostRoot(input.root);
  const name = input.name?.trim() || undefined;
  let result: HostDirRecord | undefined;
  hostDirsStore.update((data) => {
    const existing = Object.values(data.dirs).find((d) => d.ownerId === input.ownerId && d.root === root);
    const now = Date.now();
    if (existing) {
      if (name) existing.name = name;
      existing.updatedAt = now;
      result = existing;
      return;
    }
    const record: HostDirRecord = {
      id: randomUUID(),
      ownerId: input.ownerId,
      root,
      ...(name ? { name } : {}),
      createdAt: now,
      updatedAt: now,
    };
    data.dirs[record.id] = record;
    result = record;
  });
  if (!result) throw new Error("host dir upsert did not produce a record");
  return result;
}

export function renameHostDir(
  id: string,
  ownerId: number,
  name: string,
): { ok: true; dir: HostDirRecord } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (trimmed.length > 64) return { ok: false, error: "名称不能超过 64 字符" };
  let result: HostDirRecord | undefined;
  let error: string | undefined;
  hostDirsStore.update((data) => {
    const record = data.dirs[id];
    if (!record || record.ownerId !== ownerId) {
      error = "目录记录不存在";
      return;
    }
    if (trimmed) record.name = trimmed;
    else delete record.name;
    record.updatedAt = Date.now();
    result = record;
  });
  if (error || !result) return { ok: false, error: error ?? "目录记录不存在" };
  return { ok: true, dir: result };
}

/** 只删占位记录，绝不触碰真实目录。 */
export function removeHostDir(id: string, ownerId: number): boolean {
  let removed = false;
  hostDirsStore.update((data) => {
    const record = data.dirs[id];
    if (!record || record.ownerId !== ownerId) return;
    delete data.dirs[id];
    removed = true;
  });
  return removed;
}

/** 目录是否仍存在（侧栏可据此提示，不自动清理记录）。 */
export function hostDirExists(record: Pick<HostDirRecord, "root">): boolean {
  try {
    return existsSync(record.root) && statSync(record.root).isDirectory();
  } catch {
    return false;
  }
}
