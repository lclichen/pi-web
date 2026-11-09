import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAgentEventStream, listAgentEventStreams } = await jiti.import("./agent-event-stream.ts");
const decoder = new TextDecoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeData(chunk) {
  const text = decoder.decode(chunk.value);
  assert.match(text, /^data: /);
  return JSON.parse(text.slice("data: ".length));
}

test("opens the transport before a slow session is ready and snapshots after subscribing", async () => {
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  const transport = await readWithin(reader);
  assert.equal(decoder.decode(transport.value), ":\n\n");

  const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  let listener;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(nextListener) {
      subscribeCount += 1;
      listener = nextListener;
      nextListener({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      });
      nextListener({ type: "agent_start" });
      return () => {
        unsubscribeCount += 1;
      };
    },
  });

  const connected = decodeData(await readWithin(reader));
  const messageStart = decodeData(await readWithin(reader));
  const replayedEvent = decodeData(await readWithin(reader));
  assert.equal(subscribeCount, 1);
  assert.deepEqual(connected, {
    type: "connected",
    sessionId: "session-id",
    isStreaming: true,
  });
  assert.deepEqual(messageStart, { type: "agent_start" });
  assert.deepEqual(replayedEvent, { type: "message_start", message: snapshot });

  listener({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "!",
      partial: { ...snapshot },
    },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "!" },
  });

  abortController.abort();
  assert.equal(unsubscribeCount, 1);
  assert.equal((await readWithin(reader)).done, true);
});

test("reports a startup failure in-band after opening the transport", async () => {
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.reject(new Error("broken config")),
  );
  const reader = stream.getReader();

  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "startup_error",
    errorMessage: "Failed to start agent: broken config",
  });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the client cancels during startup", async () => {
  const startup = deferred();
  let subscribeCount = 0;
  const stream = createAgentEventStream(new Request("http://localhost/events"), "session-id", startup.promise);
  const reader = stream.getReader();

  await readWithin(reader);
  await reader.cancel();
  startup.resolve({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent() {
      subscribeCount += 1;
      return () => {};
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscribeCount, 0);
});

test("closes an already-aborted request and handles a later startup rejection", async () => {
  const abortController = new AbortController();
  abortController.abort();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.reject(new Error("startup failed after disconnect")),
  );

  assert.equal((await readWithin(stream.getReader())).done, true);
  await new Promise((resolve) => setImmediate(resolve));
});

// ---------------------------------------------------------------------------
// Backpressure (ported from upstream #997): a client that never reads must not
// pin unbounded memory. Frames below assume the 512KB high-water mark.
// ---------------------------------------------------------------------------

function readySession(sessionId) {
  let listener = null;
  const session = {
    isStreaming: false,
    streamingMessage: undefined,
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
    emit(event) {
      listener?.(event);
    },
  };
  return { session, sessionPromise: Promise.resolve(session) };
}

function textDeltaEvent(delta) {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: delta }] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  };
}

function bigMessageStartEvent(bytes) {
  const filler = "x".repeat(bytes);
  return { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: filler }] } };
}

test("drops rebuildable deltas once the client falls behind the high-water mark", async () => {
  const { session, sessionPromise } = readySession();
  const stream = createAgentEventStream(new Request("http://localhost/events"), "dropped-session", sessionPromise);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const bigDelta = "y".repeat(600 * 1024);
  session.emit(textDeltaEvent(bigDelta)); // fills the queue past the mark
  session.emit(textDeltaEvent(bigDelta)); // droppable + queue above mark → dropped
  session.emit(textDeltaEvent(bigDelta)); // dropped again

  const infos = listAgentEventStreams().filter((info) => info.sessionId === "dropped-session");
  assert.equal(infos.length, 1);
  assert.ok(infos[0].droppedEvents >= 2, `expected dropped deltas, got ${infos[0].droppedEvents}`);
  assert.ok(infos[0].queuedBytes > 512 * 1024, "first big delta should still be queued");

  await stream.cancel();
  assert.equal(listAgentEventStreams().filter((info) => info.sessionId === "dropped-session").length, 0);
});

test("terminates the stream when the backlog limit is exceeded", async () => {
  const { session, sessionPromise } = readySession();
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(1024 * 1024); // 1MB for a fast test
  try {
    const stream = createAgentEventStream(new Request("http://localhost/events"), "backlog-session", sessionPromise);
    const reader = stream.getReader();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Non-droppable frames (message_start snapshots) never get dropped — the
    // only escape past the limit is terminating the connection.
    for (let i = 0; i < 8; i += 1) {
      session.emit(bigMessageStartEvent(300 * 1024));
    }

    await assert.rejects(
      () => reader.read(),
      /client backlog exceeded/,
    );
    assert.equal(listAgentEventStreams().filter((info) => info.sessionId === "backlog-session").length, 0);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("coalesces tool_execution_update bursts into the latest update per tool call", async () => {
  const { session, sessionPromise } = readySession();
  const stream = createAgentEventStream(new Request("http://localhost/events"), "coalesce-session", sessionPromise);
  const reader = stream.getReader();
  // Consume the leading comment frame emitted at transport open.
  const opening = await readWithin(reader);
  assert.equal(decoder.decode(opening.value), ":\n\n");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  session.emit({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "phase 1" }] },
  });
  session.emit({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "phase 2" }] },
  });
  session.emit({
    type: "tool_execution_update",
    toolCallId: "call-2",
    toolName: "read",
    partialResult: { content: [{ type: "text", text: "other tool" }] },
  });

  const connected = decodeData(await readWithin(reader));
  assert.equal(connected.type, "connected");

  // The flush waits TOOL_UPDATE_COALESCE_MS (150ms); latest per tool call wins.
  const first = decodeData(await readWithin(reader, 2_000));
  assert.equal(first.type, "tool_execution_update");
  assert.equal(first.toolCallId, "call-1");
  assert.equal(first.partialResult.content[0].text, "phase 2");

  const second = decodeData(await readWithin(reader, 2_000));
  assert.equal(second.type, "tool_execution_update");
  assert.equal(second.toolCallId, "call-2");

  // And tool_execution_end cancels a still-pending update for that call.
  session.emit({
    type: "tool_execution_update",
    toolCallId: "call-3",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "zombie" }] },
  });
  session.emit({ type: "tool_execution_end", toolCallId: "call-3" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await reader.cancel();
});

test("streams accumulate no global listener state after cleanup", async () => {
  const { sessionPromise } = readySession();
  const stream = createAgentEventStream(new Request("http://localhost/events"), "registry-session", sessionPromise);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listAgentEventStreams().filter((info) => info.sessionId === "registry-session").length, 1);
  await stream.cancel();
  assert.equal(listAgentEventStreams().filter((info) => info.sessionId === "registry-session").length, 0);
});
