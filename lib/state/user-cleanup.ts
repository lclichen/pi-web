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
import { deleteUserTasks } from "../batch/task-store";
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

  // Stop the user's live agent sessions before their homes/session files are
  // removed; a running wrapper must not keep writing into a deleted user dir.
  try {
    const { getRpcSession, getRunningRpcSessionInfos } = await import("../rpc-manager");
    for (const info of getRunningRpcSessionInfos()) {
      if (info.ownerId !== userId) continue;
      await getRpcSession(info.sessionId)?.shutdown().catch(() => undefined);
    }
  } catch {
    // rpc-manager unavailable (tests/trimmed builds)
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
    rmSync(join(dataDir(), "batch-homes", taskId), { recursive: true, force: true });
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
