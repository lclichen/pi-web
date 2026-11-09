/**
 * Shared SSE stream plumbing for pi-web's control-plane streams
 * (terminals, relay status, …) — transport-unification P1 (harness-research
 * 08 文档).
 *
 * Consolidates what four hand-rolled routes each reimplemented with
 * different completeness: JSON data frames, a 30s comment heartbeat,
 * client-abort teardown, graceful close, and registration in the shared
 * process-shutdown closer registry (closeAllAgentEventStreams) so
 * SIGINT/SIGTERM terminates every live stream with a hard error frame
 * instead of leaving it to the 2s force-exit window (lib/shutdown.ts) to
 * cut zombie connections.
 *
 * Deliberately NOT migrated onto this helper: the agent event stream
 * (lib/agent-event-stream.ts — upstream-shared, snapshot/replay semantics)
 * and the batch task stream (lib/batch/task-event-stream.ts — sequenced
 * envelope + buffer replay). This helper targets simple fan-out streams.
 */
import { registerEventStreamCloser } from "./agent-event-stream.ts";
import { resolveSseBacklogLimitBytes, sseByteQueuingStrategy, sseQueuedBytes } from "./sse-backpressure.ts";

export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export interface SseStreamContext {
  /** Enqueue one JSON data frame (`data: {json}\n\n`). No-op after close. */
  send(data: unknown): void;
  /** Enqueue one comment frame (`: text\n\n`); heartbeats use the bare form. */
  sendComment(text?: string): void;
  /** Gracefully end the stream after the frames written so far. Idempotent. */
  close(): void;
}

export interface SseStreamOptions {
  /** Called once when the stream opens. Return a teardown function — it runs
   *  on client abort, consumer cancel, ctx.close() and process shutdown. */
  onOpen: (ctx: SseStreamContext) => (() => void) | void;
  /** Heartbeat interval; 0 disables. Default 30s. */
  heartbeatMs?: number;
}

export function createSseStream(req: Request, options: SseStreamOptions): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let teardown: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let abortHandler: (() => void) | null = null;
        let releaseCloser: () => void = () => {};
        const backlogLimitBytes = resolveSseBacklogLimitBytes();

        // "error": hard-terminate the response (process shutdown — see
        // agent-event-stream.ts for why a plain close() zombies the socket;
        // also a slow consumer past the backlog limit). "true": graceful
        // close after the final frame was written.
        const cleanup = (closeController: boolean | "error", reason?: Error) => {
          if (closed) return;
          closed = true;
          releaseCloser();
          releaseCloser = () => {};
          if (heartbeat !== null) clearInterval(heartbeat);
          heartbeat = null;
          teardown?.();
          teardown = null;
          if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
          if (closeController === "error") {
            try {
              controller.error(reason ?? new Error("pi-web server shutting down"));
            } catch {
              /* already closed */
            }
          } else if (closeController) {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };
        cancelStream = cleanup;
        releaseCloser = registerEventStreamCloser(cleanup);

        // Terminal output bursts have no "rebuildable" frames to drop — the
        // only backpressure escape is closing the connection past the limit.
        const enqueueBounded = (text: string) => {
          if (closed) return;
          const queuedBytes = sseQueuedBytes(controller);
          if (queuedBytes === null) {
            cleanup(false);
            return;
          }
          if (queuedBytes > backlogLimitBytes) {
            console.warn(
              `[pi-web] SSE stream closed: client backlog ${Math.round(queuedBytes / 1024)} KB exceeds ${Math.round(backlogLimitBytes / 1024)} KB.`,
            );
            cleanup(
              "error",
              new Error(`pi-web SSE stream closed: client backlog exceeded ${Math.round(backlogLimitBytes / 1024)} KB`),
            );
            return;
          }
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup(false);
          }
        };
        const send = (data: unknown) => {
          enqueueBounded(`data: ${JSON.stringify(data)}\n\n`);
        };
        const sendComment = (text?: string) => {
          enqueueBounded(`:${text ? ` ${text}` : ""}\n\n`);
        };

      const ctx: SseStreamContext = {
        send,
        sendComment,
        close: () => cleanup(true),
      };
      teardown = options.onOpen(ctx) ?? null;
      if (closed) return; // onOpen synchronously closed (e.g. terminal already exited)

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => sendComment(), heartbeatMs);
      }
    },
    cancel() {
      cancelStream(false);
    },
  },
  sseByteQueuingStrategy());
}
