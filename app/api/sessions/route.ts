import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
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
import { spaceForRequest } from "@/lib/session-spaces";
import { getSessionMetas } from "@/lib/session-metas";

export const dynamic = "force-dynamic";

// GET /api/sessions[?space=host][&force=1] — sessions visible to the caller:
// their own space, plus the host space (CLI sessions) for admins via ?space=host.
// Entries carry the pi-web execution mode from the sidecar metas; live (not yet
// persisted) RPC sessions are merged in, fenced per user.
export async function GET(req: Request) {
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
    const [persistedSessions, runtimeSessions, metas] = await Promise.all([
      listAllSessions(space, { force }),
      Promise.resolve(getRpcSessionInfos())
        .then((infos) => attachSessionProjectInfo(infos.filter((s) => {
          const owner = getRpcSessionOwner(s.id);
          return user.role === "admin" || !owner || owner.ownerId === user.id;
        }))),
      Promise.resolve(getSessionMetas()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions).map((s) => ({
      ...s,
      ...(metas[s.id] ? { mode: metas[s.id].mode, ...(metas[s.id].projectId ? { projectId: metas[s.id].projectId } : {}) } : {}),
    }));
    // Live-sessions are per-user unless the caller is an admin on the host space.
    const runningSessionIds = getRunningRpcSessionInfos()
      .filter((r) => (user.role === "admin" ? true : r.ownerId === user.id))
      .map((r) => r.sessionId);
    // Web-push completion-notification suppression rides along behind the same
    // per-user fence so other users' session ids never leak.
    const visibleRunning = new Set(runningSessionIds);
    const completionNotificationSuppressedSessionIds = getCompletionNotificationSuppressedRpcSessionIds()
      .filter((sessionId) => visibleRunning.has(sessionId));
    return NextResponse.json(
      {
        sessions,
        runningSessionIds,
        completionNotificationSuppressedSessionIds,
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
