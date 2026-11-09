/**
 * Shared backpressure plumbing for pi-web's SSE streams (agent events,
 * control-plane streams, batch task views) — ported from upstream
 * agegr/pi-web `6b0c6a5` (#997, dev 批次1).
 *
 * A client that stops reading (backgrounded tab, phone, flaky network) must
 * not pin unbounded memory in this process: before the fix every
 * `controller.enqueue` landed in the ReadableStream's unbounded internal
 * queue (issue #923 measured 22.7 MB stuck behind one dead connection).
 *
 * Streams construct their ReadableStream with
 * `{ highWaterMark: STREAM_HIGH_WATER_MARK_BYTES, size: (c) => c.byteLength }`
 * so `controller.desiredSize` reports bytes below the mark; queued bytes are
 * then `mark - desiredSize`. Above the mark a stream may drop events a later
 * event repairs (streaming deltas, partial tool output); above the backlog
 * limit it must terminate the connection so the client reconnects and
 * re-snapshots instead of buffering further.
 */

export const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
export const DEFAULT_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Per-connection backlog byte limit. `PI_WEB_SSE_BACKLOG_LIMIT_BYTES`, floored
 * at 64 KB so a typo cannot disable the guard entirely.
 */
export function resolveSseBacklogLimitBytes(): number {
  const raw = Number(process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES);
  return Number.isFinite(raw) && raw >= 64 * 1024 ? raw : DEFAULT_BACKLOG_LIMIT_BYTES;
}

/**
 * Bytes currently queued on the stream, or null when the controller is closed
 * (desiredSize null) — callers treat null as "stream dead, clean up".
 */
export function sseQueuedBytes(controller: ReadableStreamDefaultController<Uint8Array>): number | null {
  const desiredSize = controller.desiredSize;
  if (desiredSize === null) return null;
  return Math.max(0, STREAM_HIGH_WATER_MARK_BYTES - desiredSize);
}

/** Queuing strategy every bounded SSE stream must pass to `new ReadableStream`. */
export function sseByteQueuingStrategy(): QueuingStrategy<Uint8Array> {
  return {
    highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  };
}
