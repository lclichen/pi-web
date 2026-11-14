import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceOperations, WorkspaceStat } from "../workspace-operations";
import { WorkspaceOperationError } from "../workspace-operations";
import {
  ATTACHMENT_VERIFY_INTERVAL_MS,
  PROJECTION_MAX_BYTES,
  PROJECTION_MAX_FILE_BYTES,
  PROJECTION_MAX_FILES,
  isAttachmentRel,
  isProjectedPath,
  isProjectionDir,
  normalizeProjectionRel,
  projectionPriority,
  projectionRootError,
} from "./policy";
import {
  gcProjectionManifests,
  loadOrMigrateManifest,
  normalizeProjectionRoot,
  saveProjectionManifest,
  withProjectionProjectLock,
  type ProjectionFileEntry,
  type ProjectionManifest,
  type ProjectionWorkspace,
} from "./manifest";
import { emptyProjectionStatus, readProjectionStatus, writeProjectionStatus, type ProjectionStatus } from "./status";

export interface ProjectionInput {
  projectId: string;
  /** Host project home; the source of `.pi/skills`, `.pi/agents`, `.pi/attachments`. */
  hostHome: string;
  workspace: WorkspaceOperations;
  workspaceMeta: ProjectionWorkspace;
  budgetMs?: number;
  /** Repair: force these rels (or directory prefixes) to Host content. */
  forcePaths?: string[];
  /** Force a full-content attachment verification. */
  forceFullVerify?: boolean;
}

export interface ProjectionResult {
  status: ProjectionStatus;
  dirty: string[];
  conflicts: string[];
  errors: Array<{ rel: string; error: string }>;
}

interface ProjectState {
  lastReconcileAt: number;
  dirty: boolean;
}

const projectState = new Map<string, ProjectState>();
const inflight = new Map<string, Promise<ProjectionResult>>();
const hostHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hostDigestOf(files: Map<string, string>): string {
  return sha256(
    Buffer.from(
      [...files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rel, hash]) => `${rel}:${hash}`)
        .join("\n"),
      "utf8",
    ),
  );
}

export function markProjectionDirty(projectId: string): void {
  const state = projectState.get(projectId) ?? { lastReconcileAt: 0, dirty: false };
  state.dirty = true;
  projectState.set(projectId, state);
}

export function markProjectionClean(projectId: string): void {
  const state = projectState.get(projectId);
  if (!state) return;
  state.dirty = false;
}

/** True when Host changed since the last reconcile (not merely TTL-expired). */
export function isProjectionDirty(projectId: string): boolean {
  return projectState.get(projectId)?.dirty === true;
}

/** A failed attempt waits the normal TTL instead of retrying on every prompt. */
export function markProjectionAttempted(projectId: string): void {
  const state = projectState.get(projectId) ?? { lastReconcileAt: 0, dirty: false };
  state.lastReconcileAt = Date.now();
  state.dirty = false;
  projectState.set(projectId, state);
}

export function projectionNeedsRun(projectId: string, ttlMs = 60_000): boolean {
  const state = projectState.get(projectId);
  if (!state || state.dirty) return true;
  return Date.now() - state.lastReconcileAt > ttlMs;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof WorkspaceOperationError) return error.code === "NOT_FOUND";
  const code = (error as { code?: unknown })?.code;
  if (code === "ENOENT" || code === "NOT_FOUND") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no such file|not found|enoent/i.test(message);
}

interface HostFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

interface HostWalkResult {
  files: HostFile[];
  truncated: { reason: string; skipped: number } | null;
}

async function walkHost(hostHome: string): Promise<HostWalkResult> {
  const files: HostFile[] = [];
  let skipped = 0;
  let truncated: HostWalkResult["truncated"] = null;

  const walk = async (relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(hostHome, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isProjectionDir(rel)) await walk(rel);
        continue;
      }
      if (!entry.isFile() || !isProjectedPath(rel)) continue;
      const abs = join(hostHome, rel);
      try {
        const info = await stat(abs);
        if (info.size > PROJECTION_MAX_FILE_BYTES) {
          skipped += 1;
          truncated = { reason: "max-file-bytes", skipped };
          continue;
        }
        files.push({ rel: normalizeProjectionRel(rel), abs, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        skipped += 1;
      }
    }
  };

  await walk(".pi");
  // Sort before caps: SKILL/scripts/references first, node_modules last.
  files.sort((a, b) => {
    const priority = projectionPriority(a.rel) - projectionPriority(b.rel);
    return priority !== 0 ? priority : a.rel.localeCompare(b.rel);
  });
  let totalBytes = 0;
  const kept: HostFile[] = [];
  for (const file of files) {
    if (kept.length >= PROJECTION_MAX_FILES || totalBytes + file.size > PROJECTION_MAX_BYTES) {
      skipped += 1;
      truncated = {
        reason: kept.length >= PROJECTION_MAX_FILES ? "max-files" : "max-bytes",
        skipped,
      };
      continue;
    }
    kept.push(file);
    totalBytes += file.size;
  }
  return { files: kept, truncated };
}

async function hashHostFile(file: HostFile): Promise<string> {
  const cached = hostHashCache.get(file.abs);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached.sha256;
  const content = await readFile(file.abs);
  const hash = sha256(content);
  hostHashCache.set(file.abs, { size: content.length, mtimeMs: file.mtimeMs, sha256: hash });
  return hash;
}

function isForced(rel: string, forcePaths: Set<string> | null): boolean {
  if (!forcePaths) return false;
  for (const path of forcePaths) {
    if (rel === path || rel.startsWith(`${path.replace(/\/+$/, "")}/`)) return true;
  }
  return false;
}

async function readWorkspaceFile(ws: WorkspaceOperations, rel: string): Promise<Buffer | null> {
  try {
    return await ws.readFile(rel);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function workspaceStat(ws: WorkspaceOperations, rel: string): Promise<WorkspaceStat | null> {
  try {
    return await ws.stat(rel);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeWorkspaceBytes(ws: WorkspaceOperations, rel: string, content: Buffer): Promise<void> {
  try {
    await ws.writeFile(rel, content);
  } catch (error) {
    if (!(error instanceof WorkspaceOperationError) || error.code !== "UNSUPPORTED") throw error;
    // Legacy relay agents: text still survives, binary does not.
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content)) throw error;
    await ws.writeFile(rel, text);
  }
}

async function deleteWorkspaceFile(ws: WorkspaceOperations, rel: string): Promise<void> {
  if (ws.remove) {
    await ws.remove(rel);
    return;
  }
  throw new WorkspaceOperationError("UNSUPPORTED", "workspace provider has no remove()");
}

export function reconcileProjection(input: ProjectionInput): Promise<ProjectionResult> {
  const existing = inflight.get(input.projectId);
  if (existing) return existing;
  const run = withProjectionProjectLock(input.projectId, () => runReconcile(input)).finally(() => {
    inflight.delete(input.projectId);
  });
  inflight.set(input.projectId, run);
  return run;
}

async function runReconcile(input: ProjectionInput): Promise<ProjectionResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (input.budgetMs ?? 5_000);
  const status: ProjectionStatus = emptyProjectionStatus();
  const previousStatus = readProjectionStatus(input.projectId, input.workspaceMeta.key);
  status.lastVerifiedAt = previousStatus?.lastVerifiedAt ?? null;

  const rootError = projectionRootError(input.workspaceMeta.root);
  if (rootError) {
    status.errors.push({ rel: "", error: rootError });
    status.durationMs = Date.now() - startedAt;
    await writeProjectionStatus(input.projectId, input.workspaceMeta.key, status);
    // Permanent config error: record the attempt so prompts are not delayed by
    // a retry on every turn; the next TTL window re-checks after a fix.
    markProjectionAttempted(input.projectId);
    return { status, dirty: [], conflicts: [], errors: status.errors };
  }

  const host = await walkHost(input.hostHome);
  const hostFiles = new Map<string, { file: HostFile; sha256: string }>();
  const hostFailed = new Set<string>();
  for (const file of host.files) {
    try {
      hostFiles.set(file.rel, { file, sha256: await hashHostFile(file) });
    } catch (error) {
      hostFailed.add(file.rel);
      status.errors.push({ rel: file.rel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  status.hostDigest = hostDigestOf(new Map([...hostFiles].map(([rel, value]) => [rel, value.sha256])));
  status.truncated = host.truncated;

  const workspace = input.workspace;
  const manifest: ProjectionManifest =
    (await loadOrMigrateManifest(input.projectId, input.workspaceMeta)) ?? {
      version: 1,
      projectId: input.projectId,
      workspace: input.workspaceMeta,
      hostDigest: "",
      updatedAt: new Date().toISOString(),
      files: {},
    };
  const manifestFiles: Record<string, ProjectionFileEntry> = { ...manifest.files };
  const forcePaths = input.forcePaths && input.forcePaths.length > 0 ? new Set(input.forcePaths) : null;

  const verifyAllAttachments =
    input.forceFullVerify ||
    !previousStatus?.lastVerifiedAt ||
    Date.now() - Date.parse(previousStatus.lastVerifiedAt) > ATTACHMENT_VERIFY_INTERVAL_MS;

  const rels = new Set<string>([...hostFiles.keys(), ...Object.keys(manifestFiles)]);
  const ordered = [...rels].sort((a, b) => {
    const priority = projectionPriority(a) - projectionPriority(b);
    return priority !== 0 ? priority : a.localeCompare(b);
  });

  const push = async (rel: string, file: HostFile): Promise<void> => {
    const content = await readFile(file.abs);
    const hash = sha256(content);
    await writeWorkspaceBytes(workspace, rel, content);
    const stat = await workspaceStat(workspace, rel);
    manifestFiles[rel] = {
      sha256: hash,
      size: stat?.size ?? content.length,
      mtimeMs: stat?.mtimeMs ?? 0,
      pushedAt: new Date().toISOString(),
    };
    status.pushed.push(rel);
  };

  for (const rel of ordered) {
    if (Date.now() > deadline) {
      status.timedOut = true;
      break;
    }
    if (hostFailed.has(rel)) continue;
    const hostEntry = hostFiles.get(rel);
    const manifestEntry = manifestFiles[rel];
    const attachment = isAttachmentRel(rel);
    let stat: WorkspaceStat | null;
    try {
      stat = await workspaceStat(workspace, rel);
    } catch (error) {
      status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (hostEntry) {
      if (!stat) {
        try {
          await push(rel, hostEntry.file);
        } catch (error) {
          status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      const needsFullHash =
        attachment && verifyAllAttachments
          ? true
          : !(
              manifestEntry &&
              manifestEntry.size === stat.size &&
              manifestEntry.mtimeMs === stat.mtimeMs
            );
      let workspaceHash = manifestEntry?.sha256 ?? "";
      if (needsFullHash) {
        try {
          const content = await readWorkspaceFile(workspace, rel);
          if (content === null) {
            await push(rel, hostEntry.file);
            continue;
          }
          workspaceHash = sha256(content);
        } catch (error) {
          status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      if (workspaceHash === hostEntry.sha256) {
        manifestFiles[rel] = {
          sha256: hostEntry.sha256,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          pushedAt: manifestEntry?.pushedAt ?? new Date().toISOString(),
        };
        status.adopted.push(rel);
        continue;
      }
      const forced = isForced(rel, forcePaths);
      if (forced || attachment || (manifestEntry && workspaceHash === manifestEntry.sha256)) {
        try {
          await push(rel, hostEntry.file);
        } catch (error) {
          status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      // Workspace has local edits: keep them.
      status.dirty.push(rel);
      continue;
    }

    // Host no longer has this file.
    if (!stat) {
      delete manifestFiles[rel];
      continue;
    }
    if (attachment || isForced(rel, forcePaths)) {
      try {
        await deleteWorkspaceFile(workspace, rel);
        delete manifestFiles[rel];
        status.deleted.push(rel);
      } catch (error) {
        status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    if (!manifestEntry) continue; // workspace-only file, not managed
    let workspaceHash = manifestEntry.sha256;
    try {
      const content = await readWorkspaceFile(workspace, rel);
      if (content === null) {
        delete manifestFiles[rel];
        continue;
      }
      const needsFullHash = !(manifestEntry.size === stat.size && manifestEntry.mtimeMs === stat.mtimeMs);
      if (needsFullHash) workspaceHash = sha256(content);
    } catch (error) {
      status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (workspaceHash === manifestEntry.sha256) {
      try {
        await deleteWorkspaceFile(workspace, rel);
        delete manifestFiles[rel];
        status.deleted.push(rel);
      } catch (error) {
        status.errors.push({ rel, error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      status.conflicts.push(rel);
    }
  }

  if (verifyAllAttachments) status.lastVerifiedAt = new Date().toISOString();
  status.updatedAt = new Date().toISOString();
  status.durationMs = Date.now() - startedAt;

  await saveProjectionManifest({
    ...manifest,
    workspace: input.workspaceMeta,
    hostDigest: status.hostDigest,
    updatedAt: status.updatedAt,
    files: manifestFiles,
  });
  await writeProjectionStatus(input.projectId, input.workspaceMeta.key, status);
  gcProjectionManifests(input.projectId, input.workspaceMeta.key);

  const hasRetryable = status.errors.length > 0 || status.timedOut;
  const state = projectState.get(input.projectId) ?? { lastReconcileAt: 0, dirty: false };
  state.lastReconcileAt = Date.now();
  state.dirty = hasRetryable;
  projectState.set(input.projectId, state);

  return { status, dirty: status.dirty, conflicts: status.conflicts, errors: status.errors };
}

/** Current workspace key/root for a project record (shared with sync). */
export function projectionWorkspaceFromDescriptor(descriptor: {
  mode: "sandbox" | "local-machine" | "ssh";
  root: string;
  backend: string;
  key: string;
}): ProjectionWorkspace {
  return {
    mode: descriptor.mode,
    root: normalizeProjectionRoot(descriptor.root),
    backend: descriptor.backend,
    key: descriptor.key,
  };
}
