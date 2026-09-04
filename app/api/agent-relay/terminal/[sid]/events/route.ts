import { authorizePtySession, subscribePtyOutput } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/terminal/[sid]/events — SSE stream of PTY output chunks
// for one session. The agent pushes pty.output event frames; the registry fans
// them out to subscribers here. Output is the most sensitive channel (shell
// echo may contain secrets typed earlier), so it requires identity + PTY
// ownership like every other verb in this stack.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return new Response(JSON.stringify({ error: "登录已失效" }), {
      status: identity.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (!authorizePtySession(sid, identity.session.user)) {
    return new Response(JSON.stringify({ error: "终端不存在" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Initial marker so the client knows the stream is alive.
      encode({ type: "ready" });

      const unsubscribe = subscribePtyOutput(sid, (data) => {
        try {
          encode({ type: "output", data });
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
