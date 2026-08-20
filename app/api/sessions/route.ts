import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionInfos } from "@/lib/rpc-manager";
import { requireUserIdentity } from "@/lib/web-session";
import { spaceForRequest } from "@/lib/session-spaces";
import { getSessionMetas } from "@/lib/session-metas";

export const dynamic = "force-dynamic";

// GET /api/sessions[?space=host] — sessions visible to the caller: their own
// space, plus the host space (CLI sessions) for admins via ?space=host.
// Entries carry the pi-web execution mode from the sidecar metas.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;

  try {
    const space = spaceForRequest(identity.session, new URL(req.url).searchParams);
    const [all, metas] = await Promise.all([listAllSessions(space), Promise.resolve(getSessionMetas())]);
    const sessions = all.map((s) => ({
      ...s,
      ...(metas[s.id] ? { mode: metas[s.id].mode, ...(metas[s.id].projectId ? { projectId: metas[s.id].projectId } : {}) } : {}),
    }));
    // Live-sessions are per-user unless the caller is an admin on the host space.
    const running = getRunningRpcSessionInfos()
      .filter((r) => (user.role === "admin" ? true : r.ownerId === user.id))
      .map((r) => r.sessionId);
    return NextResponse.json({ sessions, runningSessionIds: running });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
