import { getStatus, subscribeStatus } from "@/lib/relay/registry";
import type { RelayStatus } from "@/lib/relay/protocol";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/status/events — SSE stream of agent online/offline
// changes. Mirrors app/api/agent/running/events/route.ts: subscribe before the
// initial snapshot, push a frame on every status change, heartbeat every 30s,
// and tear down on client disconnect.
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const unsubscribe = subscribeStatus((status: RelayStatus) => {
        try {
          encode(status);
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the UI renders correctly without waiting for a change.
      encode(getStatus());

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
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
