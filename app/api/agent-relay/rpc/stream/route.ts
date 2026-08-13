import { AgentUnavailableError, relayStream } from "@/lib/relay/forward";
import type { RpcMethod } from "@/lib/relay/protocol";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/rpc/stream  { method, params? }
// SSE variant of /rpc for methods that stream incremental output (Phase 2:
// exec.stream, search.grep streaming). Emits `data: {type:"chunk",data}` per
// streamed frame and a terminal `data: {type:"end",ok,...}`. MVP methods don't
// stream, so this returns a single `end` frame today.
export async function POST(req: Request) {
  let body: { method?: unknown; params?: unknown };
  try {
    body = (await req.json()) as { method?: unknown; params?: unknown };
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const method = body.method as RpcMethod;
  if (typeof method !== "string") {
    return new Response(JSON.stringify({ error: "missing 'method'" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal?.addEventListener("abort", close);

      try {
        const result = await relayStream(method, params, (data) => send({ type: "chunk", data }));
        send({ type: "end", ok: true, result });
      } catch (err) {
        if (err instanceof AgentUnavailableError) {
          send({ type: "end", ok: false, error: err.message });
        } else {
          send({ type: "end", ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        close();
      }
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
