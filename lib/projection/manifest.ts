import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileAsync } from "../atomic-write";
import { dataDir } from "../mode-homes";

/**
 * Per-(project, workspace) projection manifest.
 *
 * `files` records what the last reconcile pushed, so skills/agents with local
 * edits can be kept (dirty) instead of overwritten. The manifest lives in the
 * data dir, never in `.pi`, and is written atomically.
 */

export const PROJECTION_MANIFEST_VERSION = 1;
export const PROJECTION_MANIFEST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProjectionWorkspace {
  mode: "sandbox" | "local-machine" | "ssh";
  /** Canonical root (slash-normalized, no trailing slash). */
  root: string;
  /** Backend identity: machineId / host:port / platform#container. */
  backend: string;
  key: string;
}

export interface ProjectionFileEntry {
  sha256: string;
  size: number;
  mtimeMs: number;
  pushedAt: string;
}

export interface ProjectionManifest {
  version: typeof PROJECTION_MANIFEST_VERSION;
  projectId: string;
  workspace: ProjectionWorkspace;
  hostDigest: string;
  updatedAt: string;
  files: Record<string, ProjectionFileEntry>;
}

export function projectionDir(projectId: string, rootDir = dataDir()): string {
  return join(rootDir, "projection", projectId);
}

function manifestPath(projectId: string, key: string, rootDir = dataDir()): string {
  return join(projectionDir(projectId, rootDir), `${key}.json`);
}

export function statusPath(projectId: string, key: string, rootDir = dataDir()): string {
  return join(projectionDir(projectId, rootDir), `${key}.status.json`);
}

export function normalizeProjectionRoot(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized || "/";
}

function validKey(key: string): boolean {
  return /^[a-f0-9]{32}$/.test(key);
}

export function loadProjectionManifest(projectId: string, key: string): ProjectionManifest | null {
  if (!validKey(key)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(projectId, key), "utf8")) as ProjectionManifest;
    if (parsed?.version !== PROJECTION_MANIFEST_VERSION || parsed.projectId !== projectId) return null;
    if (!parsed.files || typeof parsed.files !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveProjectionManifest(manifest: ProjectionManifest): Promise<void> {
  await atomicWriteFileAsync(
    manifestPath(manifest.projectId, manifest.workspace.key),
    JSON.stringify(manifest, null, 2),
    0o600,
  );
}

export function removeProjectionManifest(projectId: string, key: string): void {
  if (!validKey(key)) return;
  try {
    rmSync(manifestPath(projectId, key), { force: true });
    rmSync(statusPath(projectId, key), { force: true });
  } catch {
    // best-effort
  }
}

/** All manifests for a project, keyed by workspace key. */
export function listProjectionManifests(projectId: string): Array<{ key: string; manifest: ProjectionManifest }> {
  let names: string[];
  try {
    names = readdirSync(projectionDir(projectId));
  } catch {
    return [];
  }
  const out: Array<{ key: string; manifest: ProjectionManifest }> = [];
  for (const name of names) {
    const key = name.endsWith(".json") && !name.endsWith(".status.json") ? name.slice(0, -5) : "";
    if (!key || !validKey(key)) continue;
    const manifest = loadProjectionManifest(projectId, key);
    if (manifest) out.push({ key, manifest });
  }
  return out;
}

/**
 * If the workspace key changed but the canonical root + backend are unchanged
 * (e.g. only the workdir spelling changed), inherit the previous manifest so
 * the next reconcile does not treat everything as new. Returns the manifest
 * under the current key.
 */
export async function loadOrMigrateManifest(
  projectId: string,
  workspace: ProjectionWorkspace,
): Promise<ProjectionManifest | null> {
  const current = loadProjectionManifest(projectId, workspace.key);
  if (current) return current;
  const root = normalizeProjectionRoot(workspace.root);
  const previous = listProjectionManifests(projectId).find(
    (entry) =>
      entry.key !== workspace.key &&
      entry.manifest.workspace.mode === workspace.mode &&
      entry.manifest.workspace.backend === workspace.backend &&
      normalizeProjectionRoot(entry.manifest.workspace.root) === root,
  );
  if (!previous) return null;
  const migrated: ProjectionManifest = {
    ...previous.manifest,
    workspace,
  };
  await saveProjectionManifest(migrated);
  removeProjectionManifest(projectId, previous.key);
  return migrated;
}

/** Remove old manifests that are not the current workspace key. */
export function gcProjectionManifests(projectId: string, activeKey: string, now = Date.now()): void {
  for (const entry of listProjectionManifests(projectId)) {
    if (entry.key === activeKey) continue;
    const updated = Date.parse(entry.manifest.updatedAt);
    let mtime = 0;
    try {
      mtime = statSync(manifestPath(projectId, entry.key)).mtimeMs;
    } catch {
      // unreadable; use manifest timestamp
    }
    const age = now - (Number.isFinite(updated) ? updated : mtime);
    if (age > PROJECTION_MANIFEST_MAX_AGE_MS) removeProjectionManifest(projectId, entry.key);
  }
}

/** Serialize projection work per project (reconcile, repair, GC, migration). */
const projectLocks = new Map<string, Promise<unknown>>();

export function withProjectionProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  projectLocks.set(
    projectId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}
