import { rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../mode-homes";
import { listProjects } from "../projects";
import { deleteSessionMetasForOwner } from "../session-metas";
import { deleteSessionImages } from "../session-images";
import { spaceDir } from "../session-spaces";
import { userConfigDir, userStateRoot } from "../user-config";
import { vaultRemoveAllForUser } from "../api-key-vault";
import { revokeAllAgentTokens } from "../relay/relay-store";
import { dropWebSessionsForUser } from "../web-session";
import { dropSharesForOwner } from "../share-store";
import { deleteUserTasks, listActiveUserTasks, updateTask } from "../batch/task-store";
import { deleteProjectCascade } from "./lifecycle";
import { invalidateStatePathsUnder } from "./json-store";

/**
 * Admin DELETE user: remove local pi-web state derived from the platform
 * identity. Platform is the source of truth; this only erases the local
 * copies (logins, key vault, relay pairings, user settings/models/resources,
 * homes and managed projects). External Host workspaces are never deleted.
 */
export async function deleteUserLocalState(userId: number): Promise<void> {
  dropWebSessionsForUser(userId);
  vaultRemoveAllForUser(userId);
  dropSharesForOwner(userId);
  await revokeAllAgentTokens(userId).catch(() => 0);

  // Stop every live wrapper (running or idle/warm) before their homes and
  // session files are removed; a surviving wrapper must not keep writing into
  // a deleted user dir.
  let rpcManager: typeof import("../rpc-manager") | null = null;
  try {
    rpcManager = await import("../rpc-manager");
    await rpcManager.shutdownUserSessions(userId);
  } catch {
    // rpc-manager unavailable (tests/trimmed builds)
  }

  // Cancel active batch tasks before deleting projects/homes. A runner that
  // settles later must not recreate a record we just removed: move each task
  // to its terminal cancelled state first, then delete all terminal records.
  let removeQueued: ((taskId: string) => void) | undefined;
  try {
    ({ removeQueuedTask: removeQueued } = await import("../batch/task-runner"));
  } catch {
    // queue unavailable — store-level cancellation still stops persistence
  }
  for (const task of listActiveUserTasks(userId)) {
    removeQueued?.(task.taskId);
    try {
      await rpcManager?.getRpcSession(task.sessionId)?.shutdown();
    } catch {
      // already gone
    }
    updateTask(task.taskId, {
      state: "cancelled",
      stopReason: "cancelled",
      endedAt: Date.now(),
    });
  }

  for (const project of listProjects(userId)) {
    if (project.ownerId !== userId) continue;
    await deleteProjectCascade(project).catch(() => undefined);
  }
  for (const sessionId of deleteSessionMetasForOwner(userId)) {
    deleteSessionImages(sessionId);
  }

  const tasks = deleteUserTasks(userId);
  for (const taskId of tasks) {
    try {
      rmSync(join(dataDir(), "batch-homes", taskId), { recursive: true, force: true });
    } catch {
      // Windows may hold a handle briefly; one task must not abort cleanup.
    }
  }

  const roots = [
    userStateRoot(userId),
    userConfigDir(userId),
    join(dataDir(), "user-models", `u${userId}`),
    join(dataDir(), "user-settings", `u${userId}.json`),
    join(dataDir(), "sidebar-state", `u${userId}.json`),
    join(dataDir(), "user-runtime", `u${userId}`),
    join(dataDir(), "sandbox-homes", `u${userId}`),
    join(dataDir(), "local-homes", `u${userId}`),
    join(dataDir(), "quick-homes", `u${userId}`),
    join(dataDir(), "attachments", `u${userId}`),
    spaceDir({ kind: "user", userId }),
  ];
  for (const path of roots) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort; an orphan file must not block account deletion
    }
  }
  invalidateStatePathsUnder(userStateRoot(userId));
}
