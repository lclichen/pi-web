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
import { filterSessionsForEmbedScope } from "@/lib/embed-scope";
import { migrateQuickSessionMetas } from "@/lib/quick-project-migration";
import { getProject } from "@/lib/projects";
import { getAgentForUser } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";
import { spaceForRequest } from "@/lib/session-spaces";

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
    // A caller only ever lists their own space (host includes CLI sessions for
    // admins; regular users see their shard).
    const space = spaceForRequest(identity.session, searchParams);
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries(space)
      : listAllSessions(space, { force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    perf?.span("scan+projects");
    let metas = getSessionMetas();
    if (await migrateQuickSessionMetas(user.id)) metas = getSessionMetas();
    const enriched = withSubagentDisplayStatus(mergeSessionLists(persistedSessions, runtimeSessions)).map((s) => {
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
    // Embed access tokens see their project only; archived rows need an
    // explicit `includeArchived=1` from the widget.
    const scoped = identity.session.embed
      ? filterSessionsForEmbedScope(enriched, identity.session.embed.scope)
      : enriched;
    const includeArchived = searchParams.get("includeArchived") === "1";
    const sessions = identity.session.embed && !includeArchived
      ? scoped.filter((session) => !session.archivedAt)
      : scoped;
    const payload = {
      sessions,
      sessionListVersion,
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    };
    return perf?.attach(NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } }))
      ?? NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
