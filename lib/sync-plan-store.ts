import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFileAsync } from "./atomic-write";
import { dataDir } from "./mode-homes";
import type { ConfigWrite } from "./project-config-bundle";
import type {
  WorkspaceConfigSyncBaseline,
  WorkspaceConfigSyncFileChange,
  WorkspaceConfigSyncStats,
} from "./workspace-config-sync";

/**
 * Disk-backed plan cache for workspace-config promotion.
 *
 * The preview returns a one-shot token; apply consumes the *previewed bytes*
 * (never re-collects the workspace), after checking that the project home has
 * not drifted. Only changed writes are stored; the baseline covers every
 * collected rel (hash/null) so unchanging files are still protected.
 */

export const SYNC_PLAN_TTL_MS = 5 * 60 * 1000;
export const SYNC_PLAN_MAX_BYTES = 128 * 1024 * 1024;
const PLAN_ROOT_NAME = "sync-plans";

export interface StoredSyncPlan {
  token: string;
  userId: number;
  projectId: string;
  workspaceKey: string;
  createdAt: number;
  expiresAt: number;
  stats: WorkspaceConfigSyncStats;
  baseline: WorkspaceConfigSyncBaseline;
  preview: WorkspaceConfigSyncFileChange[];
  writes: ConfigWrite[];
  bytes: number;
}

interface PlanMetaFile {
  version: 1;
  token: string;
  userId: number;
  projectId: string;
  workspaceKey: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  bytes: number;
  stats: WorkspaceConfigSyncStats;
  baseline: WorkspaceConfigSyncBaseline;
  preview: WorkspaceConfigSyncFileChange[];
  files: Array<{ rel: string; existed: boolean; index: number }>;
}

export type LoadSyncPlanResult =
  | { ok: true; plan: StoredSyncPlan }
  | { ok: false; reason: "missing" | "expired" | "used" };

function planRoot(rootDir = dataDir()): string {
  return join(rootDir, PLAN_ROOT_NAME);
}

function tokenPattern(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(token);
}

function planDir(token: string, rootDir = dataDir()): string {
  return join(planRoot(rootDir), token);
}

export interface SaveSyncPlanInput {
  userId: number;
  projectId: string;
  workspaceKey: string;
  stats: WorkspaceConfigSyncStats;
  baseline: WorkspaceConfigSyncBaseline;
  preview: WorkspaceConfigSyncFileChange[];
  writes: ConfigWrite[];
}

/**
 * Persist a preview. Returns the token the UI must send back to apply.
 * Throws if the plan exceeds the per-plan byte cap.
 */
export async function saveSyncPlan(input: SaveSyncPlanInput): Promise<{ token: string; expiresAt: number }> {
  const bytes = input.writes.reduce((sum, write) => sum + write.content.length, 0);
  if (bytes > 64 * 1024 * 1024) throw new Error("同步内容过大（>64MB）");
  const token = randomBytes(24).toString("base64url");
  const createdAt = Date.now();
  const expiresAt = createdAt + SYNC_PLAN_TTL_MS;
  const dir = planDir(token);
  await mkdir(join(dir, "files"), { recursive: true, mode: 0o700 });

  const files: PlanMetaFile["files"] = [];
  for (let index = 0; index < input.writes.length; index += 1) {
    const write = input.writes[index];
    files.push({ rel: write.rel, existed: Boolean(write.existed), index });
    await atomicWriteFileAsync(join(dir, "files", String(index)), write.content, 0o600);
  }
  const meta: PlanMetaFile = {
    version: 1,
    token,
    userId: input.userId,
    projectId: input.projectId,
    workspaceKey: input.workspaceKey,
    createdAt,
    expiresAt,
    used: false,
    bytes,
    stats: input.stats,
    baseline: input.baseline,
    preview: input.preview,
    files,
  };
  await atomicWriteFileAsync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), 0o600);
  sweepSyncPlans();
  return { token, expiresAt };
}

async function readMeta(token: string): Promise<PlanMetaFile | null> {
  if (!tokenPattern(token)) return null;
  try {
    const raw = await readFile(join(planDir(token), "meta.json"), "utf8");
    const parsed = JSON.parse(raw) as PlanMetaFile;
    if (parsed?.version !== 1 || parsed.token !== token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadSyncPlan(token: string): Promise<LoadSyncPlanResult> {
  const meta = await readMeta(token);
  if (!meta) return { ok: false, reason: "missing" };
  if (meta.used) return { ok: false, reason: "used" };
  if (meta.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  const writes: ConfigWrite[] = [];
  try {
    for (const file of meta.files) {
      const content = await readFile(join(planDir(token), "files", String(file.index)));
      writes.push({ rel: file.rel, content, existed: file.existed });
    }
  } catch {
    return { ok: false, reason: "missing" };
  }
  return {
    ok: true,
    plan: {
      token: meta.token,
      userId: meta.userId,
      projectId: meta.projectId,
      workspaceKey: meta.workspaceKey,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      stats: meta.stats,
      baseline: meta.baseline,
      preview: meta.preview,
      writes,
      bytes: meta.bytes,
    },
  };
}

/** Mark the plan used (one-shot) and remove its bytes. Best-effort delete. */
export async function consumeSyncPlan(token: string): Promise<void> {
  const meta = await readMeta(token);
  if (!meta) return;
  await atomicWriteFileAsync(join(planDir(token), "meta.json"), JSON.stringify({ ...meta, used: true }, null, 2), 0o600);
  try {
    rmSync(planDir(token), { recursive: true, force: true });
  } catch {
    // the used flag still prevents replay
  }
}

export function deleteSyncPlan(token: string): void {
  if (!tokenPattern(token)) return;
  rmSync(planDir(token), { recursive: true, force: true });
}

/** Remove expired/used plans and enforce the total byte cap (oldest first). */
export function sweepSyncPlans(rootDir = dataDir()): void {
  const root = planRoot(rootDir);
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => tokenPattern(name));
  } catch {
    return;
  }
  const now = Date.now();
  const live: Array<{ token: string; path: string; bytes: number; createdAt: number; mtime: number }> = [];
  for (const token of names) {
    const path = join(root, token);
    let bytes = 0;
    let createdAt = 0;
    try {
      const meta = JSON.parse(readFileSyncSafe(join(path, "meta.json"))) as PlanMetaFile;
      bytes = Number(meta?.bytes) || 0;
      createdAt = Number(meta?.createdAt) || 0;
      if (meta?.used || (Number(meta?.expiresAt) || 0) <= now) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
    } catch {
      // unreadable plan: keep only briefly, then delete by mtime
    }
    try {
      if (!createdAt) createdAt = statSync(path).mtimeMs;
      live.push({ token, path, bytes: bytes || dirBytes(path), createdAt, mtime: statSync(path).mtimeMs });
    } catch {
      // vanished
    }
  }
  let total = live.reduce((sum, entry) => sum + entry.bytes, 0);
  live.sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of live) {
    if (total <= SYNC_PLAN_MAX_BYTES) break;
    rmSync(entry.path, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

function readFileSyncSafe(path: string): string {
  // Small helper kept local so sweepSyncPlans can stay synchronous like the
  // other retention sweeps.
  return readFileSync(path, "utf8");
}

function dirBytes(path: string): number {
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
      else if (entry.isDirectory()) total += dirBytes(full);
    } catch {
      // vanished
    }
  }
  return total;
}

/** Drop every plan belonging to a project (project deletion). */
export function cleanupProjectSyncPlans(projectId: string, rootDir = dataDir()): void {
  const root = planRoot(rootDir);
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => tokenPattern(name));
  } catch {
    return;
  }
  for (const token of names) {
    try {
      const meta = JSON.parse(readFileSyncSafe(join(root, token, "meta.json"))) as PlanMetaFile;
      if (meta?.projectId === projectId) rmSync(join(root, token), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
