/**
 * Batch task SSE stream — a live, replayable view of one batch task.
 *
 * Wire format (each SSE `data:` line is one JSON object):
 *   { "seq": 3, "at": 1690000000000, "event": { "type": "task_created" | "status" | "agent_event" | "result", ... } }
 * plus one unsequenced notice that may precede the replay:
 *   { "type": "notice", "notice": "event_buffer_truncated", "firstSeq": 42 }
 *
 * Semantics:
 * - The stream opens immediately, replays the task's buffered events (from
 *   task_created onward), then forwards live events until the terminal
 *   `result` event, after which it closes.
 * - Client disconnect does NOT cancel the task — the SSE stream is a view.
 *   Use POST /api/batch/tasks/{id}/cancel to stop the task itself.
 * - Reconnects re-replay from the buffer (capped; oldest events may be gone,
 *   flagged by the truncation notice). The `result` event is always the last
 *   buffered event, so a reconnect to a finished task replays to the end.
 */
import { registerEventStreamCloser } from "../agent-event-stream.ts";
import { cachedAgentEventJson } from "../agent-event-wire.ts";
import { resolveSseBacklogLimitBytes, sseByteQueuingStrategy, sseQueuedBytes } from "../sse-backpressure.ts";
import { getTask, getTaskEventBufferInfo, subscribeTaskEvents, type BatchTaskEventEnvelope } from "./task-store.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;

export function batchSseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export function createBatchTaskEventStream(taskId: string, req: Request): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let unsubscribe: (() => void) | null = null;
        let abortHandler: (() => void) | null = null;
        let releaseCloser: () => void = () => {};
        const backlogLimitBytes = resolveSseBacklogLimitBytes();

        // "error": hard-terminate (server shutting down — see agent-event-stream;
        // also a slow consumer past the backlog limit — it reconnects and
        // replays the bounded buffer). "true": graceful close after the final
        // `result` event was written.
        const cleanup = (closeController: boolean | "error", reason?: Error) => {
          if (closed) return;
          closed = true;
          releaseCloser();
          if (heartbeat !== null) clearInterval(heartbeat);
          unsubscribe?.();
          unsubscribe = null;
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
              /* stream already closed */
            }
          }
        };
        cancelStream = cleanup;
        releaseCloser = registerEventStreamCloser(cleanup);

        const enqueueText = (text: string) => {
          if (closed) return;
          const queuedBytes = sseQueuedBytes(controller);
          if (queuedBytes === null) {
            cleanup(false);
            return;
          }
          if (queuedBytes > backlogLimitBytes) {
            console.warn(
              `[pi-web] Batch task stream ${taskId} closed: client backlog ${Math.round(queuedBytes / 1024)} KB exceeds ${Math.round(backlogLimitBytes / 1024)} KB.`,
            );
            cleanup(
              "error",
              new Error(
                `pi-web batch task stream closed: client backlog exceeded ${Math.round(backlogLimitBytes / 1024)} KB`,
              ),
            );
            return;
          }
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup(false);
          }
        };
        // task-store hands the same envelope object to every subscriber, so
        // the JSON of an envelope is encoded once per event, not per viewer.
        const encode = (data: unknown) => {
          enqueueText(
            `data: ${typeof data === "object" && data !== null ? cachedAgentEventJson(data) : JSON.stringify(data)}\n\n`,
          );
        };

      const task = getTask(taskId);

      abortHandler = () => cleanup(true);
      if (req.signal.aborted || !task) {
        if (!task) encode({ type: "error", error: "Task not found" });
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

      // Flush the response headers before any task events are replayed.
      enqueueText(":\n\n");

      // Flag a partial replay before the client starts dispatching events.
      const info = getTaskEventBufferInfo(taskId);
      if (info?.truncated && info.firstSeq > 1) {
        encode({ type: "notice", notice: "event_buffer_truncated", firstSeq: info.firstSeq });
      }

      const handleEnvelope = (env: BatchTaskEventEnvelope) => {
        encode(env);
        if (env.event.type === "result") cleanup(true);
      };
      unsubscribe = subscribeTaskEvents(taskId, handleEnvelope);
      if (closed) {
        // Replay already hit the terminal result event and cleaned up —
        // undo the listener registration subscribeTaskEvents just made.
        unsubscribe();
        unsubscribe = null;
        return;
      }
    },
    cancel() {
      cancelStream(false);
    },
  },
  sseByteQueuingStrategy());
}
