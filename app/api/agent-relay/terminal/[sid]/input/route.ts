import { NextResponse } from "next/server";
import { AgentUnavailableError, relayRpc } from "@/lib/relay/forward";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/terminal/[sid]/input  { data }
// Forward keystrokes/paste to the agent's PTY stdin.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  let body: { data?: unknown } = {};
  try {
    body = (await req.json()) as { data?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    await relayRpc("pty.input", { sessionId: sid, data: String(body.data ?? "") });
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
