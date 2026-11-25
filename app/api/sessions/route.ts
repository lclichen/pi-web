import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
  withSubagentDisplayStatus,
} from "@/lib/rpc-manager";
import { startServerPerf } from "@/lib/perf";
import { getSessionMetas, inferLegacyModeFromCwd } from "@/lib/session-metas";
import { migrateQuickSessionMetas } from "@/lib/quick-project-migration";
import { getProject } from "@/lib/projects";
import { getAgentForUser } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    perf?.span("scan+projects");
    let metas = getSessionMetas();
    if (await migrateQuickSessionMetas(user.id)) metas = getSessionMetas();
    const sessions = withSubagentDisplayStatus(mergeSessionLists(persistedSessions, runtimeSessions)).map((s) => {
      const meta = metas[s.id];
      const mode = meta?.mode ?? inferLegacyModeFromCwd(s.cwd);
      const remoteProject =
        (mode === "local-machine" || mode === "ssh") && meta?.projectId ? getProject(meta.projectId) : undefined;
      let workspaceDir = remoteProject?.workdir;
      if (!workspaceDir && mode === "local-machine") {
        workspaceDir = getAgentForUser(meta?.ownerId ?? user.id)?.info?.workspaceRoot;
      }
      const ownerId = meta?.ownerId;
      return {
        ...s,
        ...(mode ? { mode, ...(meta?.projectId ? { projectId: meta.projectId } : {}) } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
        ...(ownerId !== undefined ? { ownerId } : {}),
        ...(meta?.ownerName ? { ownerName: meta.ownerName } : {}),
        ...(meta?.archivedAt ? { archivedAt: meta.archivedAt } : {}),
      };
    });
    return perf?.attach(NextResponse.json(
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    )) ?? NextResponse.json(
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
