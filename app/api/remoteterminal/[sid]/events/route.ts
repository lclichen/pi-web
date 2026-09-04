import { authorizeRemoteTerminal, subscribeRemoteTerminal } from "@/lib/remote-terminal";

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
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      encode({ type: "ready" });
      const unsubscribe = subscribeRemoteTerminal(sid, (frame) => {
        try {
          encode(frame);
        } catch {
          // controller closed
        }
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller closed
        }
      }, 30_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal?.addEventListener("abort", cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
