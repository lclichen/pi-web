import { subscribeStatus, getStatusForUser, type StatusUpdate } from "@/lib/relay/registry";
import type { RelayStatus } from "@/lib/relay/protocol";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/status/events — SSE stream of agent online/offline
// changes, **per calling user**: an agent paired by user A must never surface
// in user B's status (the top-bar button and the local-machine panel must
// agree). Mirrors app/api/agent/running/events/route.ts: subscribe before the
// initial snapshot, push a frame when THIS user's status changes, heartbeat
// every 30s, tear down on client disconnect.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return new Response("登录已失效", { status: 401 });
  }
  const userId = identity.session.user.id;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const encode = (data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const fail = (e: unknown) => {
        try { controller.close(); } catch { /* already closed */ }
        closed = true;
        if (e) console.error("[relay-status-sse]", e);
      };

      let lastSnapshot = "";
      const push = (status?: RelayStatus) => {
        try {
          const snapshotStatus = status ?? getStatusForUser(userId);
          const snapshot = JSON.stringify(snapshotStatus);
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            encode(snapshotStatus);
          }
        } catch (e) {
          fail(e);
        }
      };

      // Registry updates are user-scoped; only THIS user's changes re-render.
      const unsubscribe = subscribeStatus((update: StatusUpdate) => {
        if (update.userId === userId) push(update.status);
      });

      // Initial snapshot so the UI renders correctly without waiting for a change.
      push();

      const heartbeat = setInterval(() => {
        try {
          if (!closed) controller.enqueue(encoder.encode(":\n\n"));
        } catch (e) {
          fail(e);
        }
      }, 30_000);

      const cleanup = () => {
        closed = true;
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
