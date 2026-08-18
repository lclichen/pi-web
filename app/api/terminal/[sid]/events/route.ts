import { subscribeLocalTerminal } from "@/lib/local-terminal";

export const dynamic = "force-dynamic";

// GET /api/terminal/[sid]/events — SSE stream of PTY output chunks and the
// exit frame for one local terminal session. Same frame shape as the
// agent-relay terminal events route.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Initial marker so the client knows the stream is alive.
      encode({ type: "ready" });

      const unsubscribe = subscribeLocalTerminal(sid, (frame) => {
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
