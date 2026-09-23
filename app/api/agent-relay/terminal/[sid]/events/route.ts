import { authorizePtySession, machineForPty, subscribePtyOutput } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";
import { createSseStream, sseHeaders } from "@/lib/sse-stream";

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
  const stream = createSseStream(req, {
    onOpen({ send }) {
      // Initial marker so the client knows the stream is alive.
      send({ type: "ready" });
      return subscribePtyOutput(sid, (data) => send({ type: "output", data }), machineForPty(sid));
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
