import { NextResponse } from "next/server";
import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionAccess } from "@/lib/session-access";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { restoreSessionOptions } from "@/lib/session-restore-options";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // Fast path: already-running session
  const existing = getRpcSession(id);
  let sessionPromise: Promise<AgentSessionWrapper>;
  if (existing?.isAlive()) {
    sessionPromise = Promise.resolve(existing);
  } else {
    const access = await resolveSessionAccess(req, id);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const filePath = access.path;
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    // Same mode-extension injections as new sessions (sandbox bridge etc.).
    sessionPromise = restoreSessionOptions(req, id)
      .then((options) => startRpcSession(id, filePath, undefined, options))
      .then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
