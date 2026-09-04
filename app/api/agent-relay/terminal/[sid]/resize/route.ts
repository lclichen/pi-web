import { NextResponse } from "next/server";
import { AgentUnavailableError, relayRpc } from "@/lib/relay/forward";
import { authorizePtySession, machineForPty } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/terminal/[sid]/resize  { cols, rows }
export async function POST(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { sid } = await ctx.params;
  if (!authorizePtySession(sid, identity.session.user)) {
    return NextResponse.json({ error: "终端不存在" }, { status: 404 });
  }
  let body: { cols?: unknown; rows?: unknown } = {};
  try {
    body = (await req.json()) as { cols?: unknown; rows?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    await relayRpc("pty.resize", {
      sessionId: sid,
      cols: Number(body.cols ?? 80),
      rows: Number(body.rows ?? 24),
    }, { userId: identity.session.user.id, machineId: machineForPty(sid) });
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
