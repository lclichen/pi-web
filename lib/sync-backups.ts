import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFileAsync } from "./atomic-write";
import type { ConfigWrite } from "./project-config-bundle";

/**
 * Backups for workspace-config promotion. A backup lives under
 * `<project-home>/.pi/.sync-backups/<applyId>/`:
 *   manifest.json
 *   files/<rel>          (old content, for files that existed)
 *
 * `.sync-backups` is excluded from bundles, projection and agent access; it is
 * runtime state, never configuration.
 */

export const BACKUP_DIR = ".pi/.sync-backups";
export const BACKUP_KEEP = 10;
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;

export interface BackupFileRecord {
  rel: string;
  existed: boolean;
  oldHash: string | null;
  newHash: string | null;
}

export interface BackupManifest {
  version: 1;
  applyId: string;
  ts: string;
  type: "sync" | "rollback";
  projectId?: string;
  workspaceKey?: string;
  files: BackupFileRecord[];
}

export class SyncBaselineConflictError extends Error {
  constructor(public readonly changed: string[]) {
    super(`项目区配置在预览后发生变化（${changed.slice(0, 5).join("、")}${changed.length > 5 ? "…" : ""}），请重新预览`);
    this.name = "SyncBaselineConflictError";
  }
}

export class SyncRollbackConflictError extends Error {
  constructor(public readonly changed: string[]) {
    super(`以下文件在同步后被修改，回滚会覆盖它们：${changed.slice(0, 5).join("、")}${changed.length > 5 ? "…" : ""}`);
    this.name = "SyncRollbackConflictError";
  }
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function newApplyId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function backupRoot(home: string): string {
  return join(home, BACKUP_DIR);
}

function backupDir(home: string, applyId: string): string {
  return join(backupRoot(home), applyId);
}

function safeRel(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`非法配置路径: ${rel}`);
  }
  return normalized;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function writeManifest(home: string, manifest: BackupManifest): Promise<void> {
  await atomicWriteFileAsync(join(backupDir(home, manifest.applyId), "manifest.json"), JSON.stringify(manifest, null, 2), 0o600);
}

async function loadManifest(home: string, applyId: string): Promise<BackupManifest | null> {
  if (!/^[A-Za-z0-9-]+$/.test(applyId)) return null;
  try {
    const raw = await readFile(join(backupDir(home, applyId), "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as BackupManifest;
    return parsed && parsed.version === 1 && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

function dirSize(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    try {
      if (entry.isFile()) total += statSync(full).size;
      else if (entry.isDirectory()) total += dirSize(full);
    } catch {
      // vanished mid-walk
    }
  }
  return total;
}

/** Keep the newest {@link BACKUP_KEEP} applies and the total under the cap. */
export function pruneBackups(home: string): void {
  const root = backupRoot(home);
  let entries: string[];
  try {
    entries = readdirSync(root).filter((name) => /^[A-Za-z0-9-]+$/.test(name));
  } catch {
    return;
  }
  const stats: Array<{ name: string; path: string; size: number; mtime: number }> = [];
  for (const name of entries) {
    try {
      const path = join(root, name);
      stats.push({ name, path, size: dirSize(path), mtime: statSync(path).mtimeMs });
    } catch {
      // a backup removed mid-prune: skip
    }
  }
  stats.sort((a, b) => b.mtime - a.mtime);
  let total = stats.reduce((sum, entry) => sum + entry.size, 0);
  for (let index = 0; index < stats.length; index += 1) {
    const entry = stats[index];
    if (index < BACKUP_KEEP && total <= BACKUP_MAX_BYTES) continue;
    try {
      rmSync(entry.path, { recursive: true, force: true });
      total -= entry.size;
    } catch {
      // best-effort
    }
  }
}

export interface ApplyPlanOptions {
  projectId?: string;
  workspaceKey?: string;
  type?: "sync" | "rollback";
  /** Files to remove after the writes (rollback of added files). */
  deletes?: string[];
}

/**
 * Back up every replaced/deleted target, then atomically write all changed
 * files. On a mid-apply failure the already-replaced/deleted files are
 * restored from the backup, so the home never keeps a mixed old/new set beyond
 * the failure.
 */
export async function applyPlannedWrites(
  home: string,
  writes: ConfigWrite[],
  options: ApplyPlanOptions = {},
): Promise<{ applyId: string; backupDir: string; deleted: number }> {
  const applyId = newApplyId();
  const dir = backupDir(home, applyId);
  const filesDir = join(dir, "files");
  await mkdir(filesDir, { recursive: true, mode: 0o700 });

  const records: BackupFileRecord[] = [];
  for (const write of writes) {
    const rel = safeRel(write.rel);
    const target = join(home, rel);
    const existing = await readOptional(target);
    const record: BackupFileRecord = {
      rel,
      existed: Boolean(existing),
      oldHash: existing ? hash(existing) : null,
      newHash: hash(write.content),
    };
    records.push(record);
    if (existing) {
      await atomicWriteFileAsync(join(filesDir, rel), existing, 0o600);
    }
  }
  const deleteRecords: BackupFileRecord[] = [];
  for (const relRaw of options.deletes ?? []) {
    const rel = safeRel(relRaw);
    const existing = await readOptional(join(home, rel));
    if (!existing) continue; // nothing to delete
    deleteRecords.push({ rel, existed: true, oldHash: hash(existing), newHash: null });
    await atomicWriteFileAsync(join(filesDir, rel), existing, 0o600);
  }
  const manifest: BackupManifest = {
    version: 1,
    applyId,
    ts: new Date().toISOString(),
    type: options.type ?? "sync",
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}),
    files: [...records, ...deleteRecords],
  };
  await writeManifest(home, manifest);

  const applied: BackupFileRecord[] = [];
  const deleted: BackupFileRecord[] = [];
  try {
    for (let index = 0; index < writes.length; index += 1) {
      await atomicWriteFileAsync(join(home, records[index].rel), writes[index].content);
      applied.push(records[index]);
    }
    for (const record of deleteRecords) {
      rmSync(join(home, record.rel), { force: true });
      deleted.push(record);
    }
  } catch (err) {
    // Restore the files this apply already replaced/deleted, in reverse order.
    for (const record of deleted.reverse()) {
      try {
        const old = await readFile(join(filesDir, record.rel));
        await atomicWriteFileAsync(join(home, record.rel), old);
      } catch {
        // keep the original error; a broken restore is surfaced by the backup
      }
    }
    for (const record of applied.reverse()) {
      try {
        const target = join(home, record.rel);
        if (record.existed) {
          const old = await readFile(join(filesDir, record.rel));
          await atomicWriteFileAsync(target, old);
        } else {
          rmSync(target, { force: true });
        }
      } catch {
        // keep the original error; a broken restore is surfaced by the backup
      }
    }
    throw err;
  }
  pruneBackups(home);
  return { applyId, backupDir: dir, deleted: deleted.length };
}

export interface RollbackResult {
  applyId: string;
  restored: number;
  deleted: number;
}

/**
 * Restore one apply. Files changed since that apply are refused unless
 * `force` (the UI asks explicitly). The rollback itself is backed up, so it can
 * be rolled back again.
 */
export async function rollbackWorkspaceConfig(
  home: string,
  sourceApplyId: string,
  options: { force?: boolean; projectId?: string; workspaceKey?: string } = {},
): Promise<RollbackResult> {
  const source = await loadManifest(home, sourceApplyId);
  if (!source) throw new Error("找不到该同步备份（可能已被清理）");

  const changed: string[] = [];
  const restores: Array<{ rel: string; content: Buffer | null; current: Buffer | null }> = [];
  for (const record of source.files) {
    const rel = safeRel(record.rel);
    const current = await readOptional(join(home, rel));
    const currentHash = current ? hash(current) : null;
    if (currentHash !== record.newHash) changed.push(rel);
    const old = record.existed ? await readOptional(join(backupDir(home, source.applyId), "files", rel)) : null;
    if (record.existed && !old) throw new Error(`备份内容缺失：${rel}`);
    restores.push({ rel, content: old, current });
  }
  if (changed.length > 0 && !options.force) throw new SyncRollbackConflictError(changed);

  // Back up the current state as a rollback apply (so it can be undone).
  const writes: ConfigWrite[] = restores
    .filter((item) => item.content !== null)
    .map((item) => ({ rel: item.rel, content: item.content as Buffer, existed: Boolean(item.current) }));
  const deletes = restores.filter((item) => item.content === null).map((item) => item.rel);
  const { applyId, deleted } = await applyPlannedWrites(home, writes, {
    type: "rollback",
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}),
    deletes,
  });
  pruneBackups(home);
  return { applyId, restored: writes.length, deleted };
}

export interface BackupSummary {
  applyId: string;
  ts: string;
  type: "sync" | "rollback";
  files: number;
  bytes: number;
}

export function listWorkspaceConfigBackups(home: string, limit = 20): BackupSummary[] {
  const root = backupRoot(home);
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => /^[A-Za-z0-9-]+$/.test(name));
  } catch {
    return [];
  }
  const out: BackupSummary[] = [];
  for (const name of names) {
    const manifestPath = join(root, name, "manifest.json");
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
      if (parsed?.version !== 1) continue;
      out.push({
        applyId: name,
        ts: parsed.ts,
        type: parsed.type,
        files: parsed.files.length,
        bytes: dirSize(join(root, name)),
      });
    } catch {
      // ignore broken backup
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}
