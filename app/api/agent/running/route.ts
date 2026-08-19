import { NextResponse } from "next/server";
import { getRunningRpcSessionInfos } from "@/lib/rpc-manager";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// Running sessions are per-user; admins see all (live-status support).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;
  const runningSessionIds = getRunningRpcSessionInfos()
    .filter((r) => (user.role === "admin" ? true : r.ownerId === user.id))
    .map((r) => r.sessionId);
  return NextResponse.json(
    { runningSessionIds },
    { headers: { "Cache-Control": "no-store" } },
  );
}
