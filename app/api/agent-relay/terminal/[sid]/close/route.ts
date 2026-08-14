import { NextResponse } from "next/server";
import { AgentUnavailableError, relayRpc } from "@/lib/relay/forward";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/terminal/[sid]/close — tear down the agent PTY.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  try {
    await relayRpc("pty.close", { sessionId: sid });
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
