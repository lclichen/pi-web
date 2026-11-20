import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../mode-homes";
import { projectHome, deleteProject, type ProjectRecord } from "../projects";
import {
  deleteSessionMeta,
  deleteSessionMetasForProject,
  getSessionMeta,
  getSessionMetas,
} from "../session-metas";
import { invalidateSessionListForSession, invalidateSessionPathCache, resolveSessionPath } from "../session-reader";
import { removeApkgLockedHome } from "../apkg";
import { removeProjectPinsEverywhere, setPinnedSession } from "../sidebar-state";
import { deleteSessionImages } from "../session-images";
import { dropSharesForSession } from "../share-store";
import { deleteProjectTasks } from "../batch/task-store";

/**
 * Lifecycle cascades. Deletion routes call these only after checking live
 * runtime/batch activity; helpers themselves are idempotent and best-effort so
 * one missing sidecar never blocks the primary deletion.
 */

export interface ProjectDeleteResult {
  projectId: string;
  sessions: string[];
  batchTasks: string[];
}

/** Remove one session transcript from its owner's session space. Best-effort:
 *  the sidecar cascade must proceed even when the file was already moved or
 *  the disk is locked (Windows EPERM). */
async function deleteProjectSessionFile(sessionId: string, ownerId: number): Promise<void> {
  const space = ownerId > 0 ? ({ kind: "user", userId: ownerId } as const) : ({ kind: "host" } as const);
  let filePath = await resolveSessionPath(sessionId, space).catch(() => null);
  if (!filePath && ownerId > 0) {
    // Legacy sessions may live in the host space (auth-off / pre-shard).
    filePath = await resolveSessionPath(sessionId, { kind: "host" }).catch(() => null);
  }
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  invalidateSessionPathCache(sessionId);
  invalidateSessionListForSession(filePath, ownerId);
}

export async function deleteProjectCascade(project: ProjectRecord): Promise<ProjectDeleteResult> {
  const home = projectHome(project);
  const projectSessions = Object.entries(getSessionMetas())
    .filter(([, meta]) => meta.projectId === project.id)
    .map(([sessionId, meta]) => ({ sessionId, ownerId: meta.ownerId }));

  // Stop idle/warm wrappers for this project before removing their homes and
  // transcripts. The DELETE route rejects running sessions/tasks first; this
  // closes the gap left by idle wrappers that the busy check correctly treats
  // as non-running but that still hold cwd/filesystem handles.
  try {
    const { shutdownProjectSessions } = await import("../rpc-manager");
    await shutdownProjectSessions(project.id);
  } catch {
    // Runtime registry unavailable (tests/trimmed builds) — continue.
  }

  // Remove cross-store references before the project record/home disappears.
  for (const session of projectSessions) {
    setPinnedSession(session.ownerId, session.sessionId, false);
    deleteSessionImages(session.sessionId);
    dropSharesForSession(session.sessionId);
    await deleteProjectSessionFile(session.sessionId, session.ownerId);
  }
  deleteSessionMetasForProject(project.id);
  removeProjectPinsEverywhere(project.id);
  removeApkgLockedHome(home);
  const batchTasks = deleteProjectTasks(project.id);
  for (const taskId of batchTasks) {
    try {
      rmSync(join(dataDir(), "batch-homes", taskId), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  deleteProject(project.id);
  return { projectId: project.id, sessions: projectSessions.map((s) => s.sessionId), batchTasks };
}

export function deleteSessionCascade(sessionId: string, ownerId?: number): void {
  const meta = getSessionMeta(sessionId);
  const owner = ownerId ?? meta?.ownerId ?? 0;

  deleteSessionMeta(sessionId);
  setPinnedSession(owner, sessionId, false);
  dropSharesForSession(sessionId);

  // Fallback attachment bucket is session-scoped. Project attachments live in
  // the project home and are intentionally left to project deletion.
  try {
    rmSync(join(dataDir(), "attachments", `u${owner}`, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function projectHomeExists(project: ProjectRecord): boolean {
  try {
    return existsSync(projectHome(project));
  } catch {
    return false;
  }
}
