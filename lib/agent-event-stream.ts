import {
  cachedAgentEventJson,
  cachedClientAgentEvent,
  isEventIncludedInSnapshot,
  type AgentEventLike,
} from "./agent-event-wire.ts";
import {
  resolveSseBacklogLimitBytes,
  sseByteQueuingStrategy,
  sseQueuedBytes,
  STREAM_HIGH_WATER_MARK_BYTES,
} from "./sse-backpressure.ts";
import { acquireSessionLivenessLease } from "./session-liveness.ts";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  isAlive?(): boolean;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
}

/**
 * How long `tool_execution_update` events wait to be coalesced (ported from
 * upstream agegr/pi-web `b8e0b71`). Each update carries the tool's whole
 * partial result, so only the latest one per tool call matters: a burst
 * inside the window reaches the client as one event per tool call.
 */
export const TOOL_UPDATE_COALESCE_MS = 150;

const BACKPRESSURE_LOG_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
let lastBackpressureLogAt = 0;

/**
 * Whether a later event repairs this one if it is dropped (upstream #997). A
 * `*_delta` only extends a block that its `*_end` replaces with the
 * authoritative content, and `tool_execution_update` carries the whole
 * partial result, which the next update or `tool_execution_end` supersedes.
 * `*_start` / `*_end` are never dropped: the client's stream reducer creates
 * and finalizes blocks from them.
 */
function isDroppableEvent(event: AgentEventLike): boolean {
  if (event.type === "tool_execution_update") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return (
    typeof update === "object" &&
    update !== null &&
    typeof (update as { type?: unknown }).type === "string" &&
    (update as { type: string }).type.endsWith("_delta")
  );
}

function logBackpressure(
  sessionId: string,
  queuedBytes: number,
  limitBytes: number,
  droppedEvents: number,
  closing: boolean,
): void {
  const now = Date.now();
  if (now - lastBackpressureLogAt < BACKPRESSURE_LOG_INTERVAL_MS) return;
  lastBackpressureLogAt = now;
  const queued = `${Math.round(queuedBytes / 1024)} KB`;
  console.warn(
    closing
      ? `[pi-web] Agent event stream for ${sessionId} closed: client backlog ${queued} exceeds ${Math.round(limitBytes / 1024)} KB; it reconnects and re-snapshots.`
      : `[pi-web] Agent event stream for ${sessionId} is behind (${queued} queued): dropping rebuildable deltas (${droppedEvents} so far).`,
  );
}

/**
 * Registry of live SSE streams, closed from the SIGINT/SIGTERM hook in
 * instrumentation.ts.
 *
 * In production Next 16 handles those signals with `server.close()` and waits
 * for every connection to end, with no timeout and no `closeAllConnections`
 * (that call is dev-only in next/dist/server/lib/start-server.js). An SSE
 * stream only ends when the client disconnects, so without this the process
 * stops listening (502 upstream) but never exits.
 *
 * instrumentation.ts and the route handlers are bundled into separate module
 * graphs, each with its own copy of this module; a plain module-level Set
 * would be two disconnected registries. Symbol.for + globalThis shares one.
 */
const CLOSER_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamClosers");
export type StreamCloser = (closeController: boolean | "error") => void;
const activeStreamClosers: Set<StreamCloser> = ((globalThis as Record<symbol, Set<StreamCloser>>)[CLOSER_REGISTRY] ??=
  new Set());

/** Read-only stream metadata for the Debug panel. */
export interface AgentEventStreamInfo {
  sessionId: string;
  openedAt: number;
  connectedAt: number | null;
  lastWriteAt: number | null;
  bytesWritten: number;
  /** Events dropped by backpressure (rebuildable deltas). */
  droppedEvents: number;
  /** Bytes currently queued behind a slow consumer. */
  queuedBytes: number;
}

interface LiveStreamInfo {
  sessionId: string;
  openedAt: number;
  connectedAt: number | null;
  lastWriteAt: number | null;
  bytesWritten: number;
  droppedEvents(): number;
  queuedBytes(): number;
}

const STREAM_INFO_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamInfos");
const activeStreamInfos: Map<symbol, LiveStreamInfo> = ((
  globalThis as Record<symbol, Map<symbol, LiveStreamInfo>>
)[STREAM_INFO_REGISTRY] ??= new Map());

export function listAgentEventStreams(): AgentEventStreamInfo[] {
  return Array.from(activeStreamInfos.values(), (info) => {
    let droppedEvents = 0;
    let queuedBytes = 0;
    try {
      droppedEvents = info.droppedEvents();
      queuedBytes = info.queuedBytes();
    } catch {
      // An entry another module graph version left behind.
    }
    return {
      sessionId: info.sessionId,
      openedAt: info.openedAt,
      connectedAt: info.connectedAt,
      lastWriteAt: info.lastWriteAt,
      bytesWritten: info.bytesWritten,
      droppedEvents,
      queuedBytes,
    };
  });
}

/**
 * Register an SSE stream closer in the shared shutdown registry (invoked by
 * closeAllAgentEventStreams on process shutdown signals). Shared by the agent
 * event stream and the batch task stream so both terminate on SIGINT/SIGTERM.
 */
export function registerEventStreamCloser(closer: StreamCloser): () => void {
  activeStreamClosers.add(closer);
  return () => {
    activeStreamClosers.delete(closer);
  };
}

/** Close every live SSE stream (called on process shutdown signals). */
export function closeAllAgentEventStreams(): void {
  for (const close of [...activeStreamClosers]) {
    try {
      close("error");
    } catch {
      /* stream already closed */
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 *
 * Backpressure (ported from upstream #997): above STREAM_HIGH_WATER_MARK the
 * stream drops events a later event repairs; above the backlog limit it
 * terminates so the client reconnects and re-snapshots. Without this a client
 * that stops reading pins unbounded memory in this process.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};
  let releaseLease: () => void = () => {};

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let unsubscribe: (() => void) | null = null;
        let abortHandler: (() => void) | null = null;
        // Latest `tool_execution_update` per tool call id, waiting for the flush.
        const pendingToolUpdates = new Map<unknown, AgentEventLike>();
        let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;
        const infoKey = Symbol(sessionId);
        const streamInfo: LiveStreamInfo = {
          sessionId,
          openedAt: Date.now(),
          connectedAt: null,
          lastWriteAt: null,
          bytesWritten: 0,
          droppedEvents: () => droppedEvents,
          queuedBytes: () => sseQueuedBytes(controller) ?? 0,
        };
        activeStreamInfos.set(infoKey, streamInfo);

        // "error": hard-terminate the response (SSE client sees a broken
        // stream and reconnects). Used on process shutdown: a plain close() is
        // swallowed by the Next/Node response pipeline without emitting a
        // chunked termination, so the socket stays ESTABLISHED and Next's
        // server.close() drain never completes (the original zombie bug).
        // Also used when a client stops consuming: a graceful close() there
        // would leave the socket (and the queued backlog) alive.
        // "true": graceful close after we finished writing a final event.
        const cleanup = (closeController: boolean | "error", reason?: Error) => {
          if (closed) return;
          closed = true;
          releaseLease();
          releaseLease = () => {};
          activeStreamClosers.delete(cleanup);
          activeStreamInfos.delete(infoKey);
          if (heartbeat !== null) clearInterval(heartbeat);
          if (toolUpdateTimer !== null) clearTimeout(toolUpdateTimer);
          pendingToolUpdates.clear();
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
        releaseLease = acquireSessionLivenessLease(sessionId).release;
        activeStreamClosers.add(cleanup);

        const backlogLimitBytes = resolveSseBacklogLimitBytes();
        let droppedEvents = 0;
        const enqueueText = (text: string, options?: { droppable?: boolean }) => {
          if (closed) return;
          const queuedBytes = sseQueuedBytes(controller);
          if (queuedBytes === null) {
            cleanup(false);
            return;
          }
          if (options?.droppable && queuedBytes > STREAM_HIGH_WATER_MARK_BYTES) {
            droppedEvents += 1;
            logBackpressure(sessionId, queuedBytes, backlogLimitBytes, droppedEvents, false);
            return;
          }
          if (queuedBytes > backlogLimitBytes) {
            logBackpressure(sessionId, queuedBytes, backlogLimitBytes, droppedEvents, true);
            cleanup(
              "error",
              new Error(
                `pi-web agent event stream closed: client backlog exceeded ${Math.round(backlogLimitBytes / 1024)} KB`,
              ),
            );
            return;
          }
          try {
            const bytes = encoder.encode(text);
            controller.enqueue(bytes);
            streamInfo.bytesWritten += bytes.byteLength;
            streamInfo.lastWriteAt = Date.now();
          } catch {
            cleanup(false);
          }
        };
        const encode = (data: unknown, options?: { droppable?: boolean }) => {
          enqueueText(
            `data: ${typeof data === "object" && data !== null ? cachedAgentEventJson(data) : JSON.stringify(data)}\n\n`,
            options,
          );
        };
        const flushToolUpdates = () => {
          toolUpdateTimer = null;
          const updates = [...pendingToolUpdates.values()];
          pendingToolUpdates.clear();
          for (const update of updates) encode(update, { droppable: true });
        };
        const sendClientEvent = (clientEvent: AgentEventLike) => {
          if (clientEvent.type === "tool_execution_update") {
            pendingToolUpdates.set(clientEvent.toolCallId, clientEvent);
            toolUpdateTimer ??= setTimeout(flushToolUpdates, TOOL_UPDATE_COALESCE_MS);
            return;
          }
          // The end supersedes a partial result still waiting here, and the
          // client would treat one arriving after the end as a tool that is
          // running again. agent_end does the same for any tool call whose
          // end never came.
          if (clientEvent.type === "tool_execution_end") {
            pendingToolUpdates.delete(clientEvent.toolCallId);
          } else if (clientEvent.type === "agent_end") {
            pendingToolUpdates.clear();
          }
          encode(clientEvent, { droppable: isDroppableEvent(clientEvent) });
        };
        const forwardEvent = (event: AgentEventLike, snapshot: unknown) => {
          if (isEventIncludedInSnapshot(event, snapshot)) return;
          const clientEvent = cachedClientAgentEvent(event);
          if (clientEvent) sendClientEvent(clientEvent);
        };

        const publishSession = async () => {
          try {
            const session = await sessionPromise;
            if (closed) return;
            if (session.isAlive && !session.isAlive()) {
              cleanup(true);
              return;
            }

            const bufferedEvents: AgentEventLike[] = [];
            let snapshotPublished = false;
            const handleEvent = (event: AgentEventLike) => {
              if (event.type === "session_shutdown") {
                cleanup(true);
                return;
              }
              if (!snapshotPublished) {
                bufferedEvents.push(event);
                return;
              }
              forwardEvent(event, snapshot);
            };

            const stopListening = session.onEvent(handleEvent);
            if (closed) {
              stopListening();
              return;
            }
            if (session.isAlive && !session.isAlive()) {
              stopListening();
              cleanup(true);
              return;
            }
            unsubscribe = stopListening;

            const snapshot = session.streamingMessage;
            streamInfo.connectedAt = Date.now();
            encode({
              type: "connected",
              sessionId,
              isStreaming: session.isStreaming,
            });
            for (const event of bufferedEvents) forwardEvent(event, snapshot);
            if (snapshot !== undefined && snapshot !== null) {
              encode({ type: "message_start", message: snapshot });
            }
            snapshotPublished = true;
          } catch (error) {
            if (closed) return;
            encode({
              type: "startup_error",
              errorMessage: `Failed to start agent: ${errorMessage(error)}`,
            });
            cleanup(true);
          }
        };

        // Attach the rejection handler before checking the request signal. The
        // route may already have started a shared cold-start promise.
        void publishSession();

        abortHandler = () => cleanup(true);
        if (req.signal.aborted) {
          cleanup(true);
          return;
        }
        req.signal.addEventListener("abort", abortHandler, { once: true });

        heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

        // Force the response headers through without claiming that the agent is
        // ready. The client waits for the later `connected` data event.
        enqueueText(":\n\n");
      },
      cancel() {
        cancelStream(false);
      },
    },
    sseByteQueuingStrategy(),
  );
}
