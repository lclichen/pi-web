import { NextResponse } from "next/server";
import { buildDebugSnapshot } from "@/lib/debug-snapshot";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";
// The registries it reads live in this Node process.
export const runtime = "nodejs";

const MAX_SESSION_ID_LENGTH = 512;

// GET /api/agent/debug?session=<id> - read-only server snapshot for the Debug
// panel: wrappers, streams, MCP config and idle deadlines. Never starts a
// wrapper, opens a stream or sends a command. Admin-only (auth-off = implicit
// host admin) because it exposes cross-session ownership and server internals.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  }
  const { user } = identity.session;
  if (user.id !== 0 && user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可查看调试信息" }, { status: 403 });
  }

  const requested = new URL(req.url).searchParams.get("session");
  const sessionId = requested && requested.length <= MAX_SESSION_ID_LENGTH ? requested : null;
  return NextResponse.json(buildDebugSnapshot(sessionId), {
    headers: { "Cache-Control": "no-store" },
  });
}
