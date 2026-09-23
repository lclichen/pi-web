import { subscribeLocalTerminal } from "@/lib/local-terminal";
import { createSseStream, sseHeaders } from "@/lib/sse-stream";

export const dynamic = "force-dynamic";

// GET /api/terminal/[sid]/events — SSE stream of PTY output chunks and the
// exit frame for one local terminal session. Same frame shape as the
// agent-relay terminal events route.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  const stream = createSseStream(req, {
    onOpen({ send }) {
      // Initial marker so the client knows the stream is alive.
      send({ type: "ready" });
      return subscribeLocalTerminal(sid, (frame) => send(frame));
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
