import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../mode-homes";
import { projectHome, deleteProject, type ProjectRecord } from "../projects";
import {
  deleteSessionMeta,
  deleteSessionMetasForProject,
  getSessionMeta,
  getSessionMetas,
} from "../session-metas";
import { removeApkgLockedHome } from "../apkg";
import { removeProjectPinsEverywhere, setPinnedSession } from "../sidebar-state";
import { deleteSessionImages } from "../session-images";
import { dropSharesForSession, dropSharesForOwner } from "../share-store";
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

export async function deleteProjectCascade(project: ProjectRecord): Promise<ProjectDeleteResult> {
  const home = projectHome(project);
  const projectSessions = Object.entries(getSessionMetas())
    .filter(([, meta]) => meta.projectId === project.id)
    .map(([sessionId, meta]) => ({ sessionId, ownerId: meta.ownerId }));

  // Remove cross-store references before the project record/home disappears.
  for (const session of projectSessions) {
    setPinnedSession(session.ownerId, session.sessionId, false);
    deleteSessionImages(session.sessionId);
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
