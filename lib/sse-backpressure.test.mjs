import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_BACKLOG_LIMIT_BYTES,
  STREAM_HIGH_WATER_MARK_BYTES,
  resolveSseBacklogLimitBytes,
  sseByteQueuingStrategy,
  sseQueuedBytes,
} = await jiti.import("./sse-backpressure.ts");

test("defaults match the ported upstream backpressure budget", () => {
  assert.equal(STREAM_HIGH_WATER_MARK_BYTES, 512 * 1024);
  assert.equal(DEFAULT_BACKLOG_LIMIT_BYTES, 16 * 1024 * 1024);
});

test("resolveSseBacklogLimitBytes reads the env with a 64KB floor", () => {
  const previous = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  try {
    delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    assert.equal(resolveSseBacklogLimitBytes(), DEFAULT_BACKLOG_LIMIT_BYTES);

    process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(1024 * 1024);
    assert.equal(resolveSseBacklogLimitBytes(), 1024 * 1024);

    // Values below the floor (typos, "0" to disable) fall back to the default.
    process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = "10";
    assert.equal(resolveSseBacklogLimitBytes(), DEFAULT_BACKLOG_LIMIT_BYTES);
    process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = "not-a-number";
    assert.equal(resolveSseBacklogLimitBytes(), DEFAULT_BACKLOG_LIMIT_BYTES);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previous;
  }
});

test("sseQueuedBytes derives queued bytes from desiredSize", () => {
  assert.equal(sseQueuedBytes({ desiredSize: null }), null);
  assert.equal(sseQueuedBytes({ desiredSize: STREAM_HIGH_WATER_MARK_BYTES }), 0);
  assert.equal(sseQueuedBytes({ desiredSize: 0 }), STREAM_HIGH_WATER_MARK_BYTES);
  // A slow consumer past the mark drives desiredSize negative.
  assert.equal(sseQueuedBytes({ desiredSize: -1024 }), STREAM_HIGH_WATER_MARK_BYTES + 1024);
});

test("sseByteQueuingStrategy sizes chunks in bytes at the high-water mark", () => {
  const strategy = sseByteQueuingStrategy();
  assert.equal(strategy.highWaterMark, STREAM_HIGH_WATER_MARK_BYTES);
  const chunk = new Uint8Array(300);
  assert.equal(strategy.size(chunk), 300);
});
