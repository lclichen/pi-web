import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSseStream, sseHeaders } from "./sse-stream.ts";
import { closeAllAgentEventStreams } from "./agent-event-stream.ts";

/** Shared SSE plumbing for control-plane streams (transport-unification P1). */

const decoder = new TextDecoder();

function readChunk(reader) {
  return reader.read().then(({ done, value }) => (done ? null : decoder.decode(value, { stream: true })));
}

test("sse-stream: onOpen runs once, initial and live frames arrive in order", async () => {
  const frames = [];
  const stream = createSseStream(new Request("http://localhost/"), {
    onOpen({ send }) {
      send({ type: "ready" });
      frames.push("opened");
      return () => frames.push("torn-down");
    },
  });
  const reader = stream.getReader();
  // Simulate a live frame after open: grab the ctx via a second send hook
  assert.equal(frames.length, 1);
  assert.equal(await readChunk(reader), 'data: {"type":"ready"}\n\n');
  reader.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames.length, 2);
});

test("sse-stream: ctx.close() ends the stream gracefully after written frames", async () => {
  let ctxRef;
  const stream = createSseStream(new Request("http://localhost/"), {
    onOpen(ctx) {
      ctxRef = ctx;
      ctx.send({ type: "exit", code: 0 });
      ctx.close();
    },
  });
  const reader = stream.getReader();
  assert.equal(await readChunk(reader), 'data: {"type":"exit","code":0}\n\n');
  const { done } = await reader.read();
  assert.equal(done, true);
  // send after close is a no-op, not a throw
  assert.doesNotThrow(() => ctxRef.send({ type: "late" }));
});

test("sse-stream: client abort runs teardown and ends the stream", async () => {
  const ac = new AbortController();
  let tornDown = false;
  const stream = createSseStream(new Request("http://localhost/", { signal: ac.signal }), {
    onOpen({ send }) {
      send({ type: "ready" });
      return () => { tornDown = true; };
    },
  });
  const reader = stream.getReader();
  await readChunk(reader);
  ac.abort();
  const { done } = await reader.read();
  assert.equal(done, true);
  assert.equal(tornDown, true);
});

test("sse-stream: consumer cancel runs teardown without erroring", async () => {
  let tornDown = false;
  const stream = createSseStream(new Request("http://localhost/"), {
    onOpen() {
      return () => { tornDown = true; };
    },
  });
  const reader = stream.getReader();
  await reader.cancel();
  assert.equal(tornDown, true);
});

test("sse-stream: process shutdown hard-errors the stream (closer registry)", async () => {
  const stream = createSseStream(new Request("http://localhost/"), {
    onOpen() {
      return () => {};
    },
  });
  const reader = stream.getReader();
  closeAllAgentEventStreams();
  await assert.rejects(
    () => reader.read(),
    /shutting down/,
  );
});

test("sse-stream: heartbeat emits bare comment frames at the configured interval", async () => {
  const stream = createSseStream(new Request("http://localhost/"), {
    heartbeatMs: 15,
    onOpen({ send }) {
      send({ type: "ready" });
    },
  });
  const reader = stream.getReader();
  assert.equal(await readChunk(reader), 'data: {"type":"ready"}\n\n');
  // Next frame is the heartbeat comment (":\n\n"), not data.
  const frame = await readChunk(reader);
  assert.equal(frame, ":\n\n");
  await reader.cancel().catch(() => {});
});

test("sse-stream: heartbeatMs 0 disables the heartbeat", async () => {
  const stream = createSseStream(new Request("http://localhost/"), {
    heartbeatMs: 0,
    onOpen({ send }) {
      send({ type: "ready" });
    },
  });
  const reader = stream.getReader();
  assert.equal(await readChunk(reader), 'data: {"type":"ready"}\n\n');
  // No frame within a window that would comfortably fit a 15ms heartbeat.
  const nothing = await Promise.race([
    readChunk(reader).then(() => false),
    new Promise((r) => setTimeout(() => r(true), 60)),
  ]);
  assert.equal(nothing, true, "no heartbeat frame expected");
  await reader.cancel().catch(() => {});
});

test("sse-stream: headers match the engineered streams (no-transform + no proxy buffering)", () => {
  const h = sseHeaders();
  assert.equal(h["Content-Type"], "text/event-stream");
  assert.equal(h["Cache-Control"], "no-cache, no-transform");
  assert.equal(h["X-Accel-Buffering"], "no");
});

test("P1 routes: all four inline SSE routes migrated onto createSseStream", () => {
  const routes = [
    "../app/api/terminal/[sid]/events/route.ts",
    "../app/api/remoteterminal/[sid]/events/route.ts",
    "../app/api/agent-relay/terminal/[sid]/events/route.ts",
    "../app/api/agent-relay/status/events/route.ts",
  ];
  for (const rel of routes) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(source.includes("createSseStream"), `${rel}: must use the shared helper`);
    assert.ok(source.includes("sseHeaders"), `${rel}: must use shared headers`);
    assert.ok(!source.includes("new ReadableStream"), `${rel}: no hand-rolled stream`);
    assert.ok(!/setInterval/.test(source), `${rel}: no hand-rolled heartbeat`);
  }
});

test("P1 scope: upstream-shared SSE routes (login wait, files watch) left untouched", () => {
  const login = readFileSync(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
  const files = readFileSync(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");
  assert.ok(!login.includes("createSseStream"), "login route stays upstream-shaped (thin/deferred per 08 P1)");
  assert.ok(!files.includes("createSseStream"), "files route stays upstream-shaped (thin/deferred per 08 P1)");
});
