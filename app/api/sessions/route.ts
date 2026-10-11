import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRpcSessionOwner,
  getRunningRpcSessionInfos,
} from "@/lib/rpc-manager";
import { requireUserIdentity } from "@/lib/web-session";
import { spaceForRequest, isPathInSpace } from "@/lib/session-spaces";
import { allProjects } from "@/lib/projects";
import { getSessionMetas } from "@/lib/session-metas";
import { startServerPerf } from "@/lib/perf";

export const dynamic = "force-dynamic";

// GET /api/sessions[?space=host][&force=1] — sessions visible to the caller:
// their own space, plus the host space (CLI sessions) for admins via ?space=host.
// Entries carry the pi-web execution mode from the sidecar metas; live (not yet
// persisted) RPC sessions are merged in, fenced per user.
export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;

  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    const space = spaceForRequest(identity.session, searchParams);
    // MERGE-NOTE(upgrade/0.84): upstream's listAllSessions({ force }) became
    // listAllSessions(space, { force }) — dev shards the catalogue per user.
    // Runtime (not-yet-persisted) sessions are merged in per upstream, but
    // filtered to the caller's own live sessions (admins see all).
    // MERGE-NOTE(upgrade/1.0): upstream's `summary=1` fast path rides on its
    // global listSessionSummaries() cache; dev keeps the per-space full scan.
    perf?.span("start");
    const [persistedSessions, runtimeSessions, metas] = await Promise.all([
      listAllSessions(space, { force }),
      Promise.resolve(getRpcSessionInfos())
        .then((infos) => attachSessionProjectInfo(infos.filter((s) => {
          const owner = getRpcSessionOwner(s.id);
          if (user.role !== "admin" && owner && owner.ownerId !== user.id) return false;
          // Space fence: a live wrapper whose session file lives outside the
          // requested space belongs to the other tab — merging it into both
          // made the same session appear under "我的会话" AND "Host (CLI)".
          return !s.path || isPathInSpace(s.path, space);
        }))),
      Promise.resolve(getSessionMetas()),
    ]);
    // A project is the source of truth for its sessions' execution mode: an
    // entry whose sidecar mode disagrees with the owning project's mode (stale
    // metas recorded as "host" before the project-decides fix, or lost metas)
    // must not surface as Host — that flips the file/terminal panels onto the
    // host APIs and drops the relay/ssh routing the session actually needs.
    const projectModes = new Map(allProjects().map((p) => [p.id, p.mode]));
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions).map((s) => {
      const meta = metas[s.id];
      if (!meta) return s;
      const projectId = meta.projectId;
      const projectMode = projectId ? projectModes.get(projectId) : undefined;
      return {
        ...s,
        mode: projectMode ?? meta.mode,
        ...(projectId ? { projectId } : {}),
      };
    });
    // Capture AFTER the scan: mutations during the scan bump the generation,
    // so the client sees a version it cannot reconcile and refreshes again.
    const sessionListVersion = getSessionListVersion();
    perf?.span("scan+projects");
    // Live-sessions are per-user unless the caller is an admin on the host space.
    const runningSessionIds = getRunningRpcSessionInfos()
      .filter((r) => (user.role === "admin" ? true : r.ownerId === user.id))
      .map((r) => r.sessionId);
    // Web-push completion-notification suppression rides along behind the same
    // per-user fence so other users' session ids never leak.
    const visibleRunning = new Set(runningSessionIds);
    const completionNotificationSuppressedSessionIds = getCompletionNotificationSuppressedRpcSessionIds()
      .filter((sessionId) => visibleRunning.has(sessionId));
    const response = jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds,
        completionNotificationSuppressedSessionIds,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    return perf ? perf.attach(response) : response;
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
