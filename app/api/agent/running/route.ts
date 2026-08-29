import { NextResponse } from "next/server";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionInfos,
} from "@/lib/rpc-manager";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// Running sessions are per-user; admins see all (live-status support).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;
  // MERGE-NOTE(upgrade/0.84): upstream lists every running session globally;
  // dev's multi-user fence filters by ownerId instead (admins still see all).
  const runningSessionIds = getRunningRpcSessionInfos()
    .filter((r) => (user.role === "admin" ? true : r.ownerId === user.id))
    .map((r) => r.sessionId);
  // Web-push completion-notification suppression (upstream) rides along behind
  // the same per-user fence so other users' session ids never leak.
  const visible = new Set(runningSessionIds);
  const completionNotificationSuppressedSessionIds = getCompletionNotificationSuppressedRpcSessionIds()
    .filter((sessionId) => visible.has(sessionId));
  return NextResponse.json(
    {
      runningSessionIds,
      completionNotificationSuppressedSessionIds,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
