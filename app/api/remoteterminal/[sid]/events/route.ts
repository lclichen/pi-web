import { authorizeRemoteTerminal, subscribeRemoteTerminal } from "@/lib/remote-terminal";
import { createSseStream, sseHeaders } from "@/lib/sse-stream";

export const dynamic = "force-dynamic";

// GET /api/remoteterminal/[sid]/events — SSE output stream (same frame shape
// as the local and relay terminals).
export async function GET(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  const auth = authorizeRemoteTerminal(req, sid);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { "content-type": "application/json" },
    });
  }
  const stream = createSseStream(req, {
    onOpen({ send }) {
      send({ type: "ready" });
      return subscribeRemoteTerminal(sid, (frame) => send(frame));
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
