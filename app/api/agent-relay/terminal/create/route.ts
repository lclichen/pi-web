import { NextResponse } from "next/server";
import { AgentUnavailableError, relayRpc } from "@/lib/relay/forward";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/terminal/create  { shell?, cwd?, cols?, rows? }
// Ask the agent to start an interactive PTY and return its session id. The
// browser then subscribes to .../terminal/[sid]/events for output.
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine — agent uses defaults
  }
  try {
    const data = await relayRpc("pty.create", body);
    return NextResponse.json({ success: true, data });
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
