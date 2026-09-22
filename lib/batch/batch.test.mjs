import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Batch test infrastructure: task store + utils (pure, no rpc deps). */

const resetStore = () => {
  globalThis.__piWebBatchTasks = undefined;
  globalThis.__piWebBatchTaskEvents = undefined;
};

async function loadStore() {
  resetStore();
  return import("./task-store.ts");
}

async function loadUtils() {
  return import("./batch-utils.ts");
}

test.afterEach(() => {
  resetStore();
});

// ---------------------------------------------------------------------------
// Task store state machine
// ---------------------------------------------------------------------------

test("task store: create → update → terminal detection → summary", async () => {
  const store = await loadStore();
  const task = store.createTaskRecord({
    taskId: "t-1",
    sessionId: "sess-1",
    mode: "host",
    requestedWorkDir: "/tmp/test",
    actualWorkDir: "/tmp/test",
    prompt: "test prompt",
    timeoutMs: 60000,
    inputTimeoutMs: 30000,
    stopContainer: false,
  });

  assert.equal(task.state, "queued");
  assert.equal(store.isTerminal(task.state), false);

  store.updateTask("t-1", { state: "running", startedAt: Date.now() });
  assert.equal(store.getTask("t-1")?.state, "running");

  store.updateTask("t-1", { state: "completed", stopReason: "end_turn", endedAt: Date.now() });
  assert.equal(store.isTerminal(store.getTask("t-1").state), true);

  const summary = store.toSummary(store.getTask("t-1"));
  assert.equal(summary.taskId, "t-1");
  assert.equal(summary.state, "completed");
  assert.equal(summary.stopReason, "end_turn");
  assert.ok(summary.durationMs !== undefined);
  assert.equal(summary.workDir, "/tmp/test");

  // List contains both tasks (order is by createdAt; same-ms ties may vary)
  store.createTaskRecord({
    taskId: "t-2", sessionId: "", mode: "host",
    requestedWorkDir: "/tmp/t2", actualWorkDir: "", prompt: "p2",
    timeoutMs: 60000, inputTimeoutMs: 30000, stopContainer: false,
  });
  const list = store.listTasks(10);
  assert.equal(list.length, 2);
  const ids = list.map((t) => t.taskId);
  assert.ok(ids.includes("t-1") && ids.includes("t-2"));
});

// ---------------------------------------------------------------------------
// Directory preparation (auto-suffix + trust)
// ---------------------------------------------------------------------------

test("prepareWorkDir: creates fresh dir, auto-suffixes if exists", async () => {
  const { prepareWorkDirPath } = await loadUtils();
  const base = mkdtempSync(join(tmpdir(), "batch-dir-test-"));

  try {
    // First call: fresh directory
    const requested = join(base, "workspace");
    const actual1 = prepareWorkDirPath(requested);
    assert.equal(actual1, requested);
    assert.ok(existsSync(actual1));

    // Second call with same path: gets -2 suffix
    const actual2 = prepareWorkDirPath(requested);
    assert.equal(actual2, `${requested}-2`);
    assert.ok(existsSync(actual2));

    // Third call: gets -3
    const actual3 = prepareWorkDirPath(requested);
    assert.equal(actual3, `${requested}-3`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File materialization
// ---------------------------------------------------------------------------

test("materializeFiles: writes nested paths, rejects traversal", async () => {
  const { materializeFiles } = await loadUtils();
  const workDir = mkdtempSync(join(tmpdir(), "batch-files-test-"));

  try {
    materializeFiles(workDir, {
      "hello.txt": "hello world",
      "src/main.ts": "export function main() { return 1; }",
      "data/nested/deep.json": '{"key": "value"}',
    });

    assert.equal(readFileSync(join(workDir, "hello.txt"), "utf8"), "hello world");
    assert.equal(readFileSync(join(workDir, "src/main.ts"), "utf8"), "export function main() { return 1; }");
    assert.ok(existsSync(join(workDir, "data/nested/deep.json")));

    // Path traversal must be rejected
    assert.throws(
      () => materializeFiles(workDir, { "../escape.txt": "nope" }),
      /escapes workDir/,
    );
    assert.throws(
      () => materializeFiles(workDir, { "/absolute/path.txt": "nope" }),
      /escapes workDir/,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("copyPathPackage: copies directory contents", async () => {
  const { copyPathPackage } = await loadUtils();
  const workDir = mkdtempSync(join(tmpdir(), "batch-copy-test-"));
  const srcDir = mkdtempSync(join(tmpdir(), "batch-copy-src-"));

  try {
    // Build a source package
    writeFileSync(join(srcDir, "test-file.txt"), "test content", "utf8");
    mkdirSync(join(srcDir, "subdir"), { recursive: true });
    writeFileSync(join(srcDir, "subdir/nested.ts"), "export const x = 1;", "utf8");

    copyPathPackage(workDir, srcDir);

    assert.equal(readFileSync(join(workDir, "test-file.txt"), "utf8"), "test content");
    assert.equal(readFileSync(join(workDir, "subdir/nested.ts"), "utf8"), "export const x = 1;");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// API route source assertions (contract-level)
// ---------------------------------------------------------------------------

test("batch auth: uses X-Platform-API-Key header, validates against platform", async () => {
  const source = readFileSync(new URL("./batch-auth.ts", import.meta.url), "utf8");
  assert.match(source, /x-platform-api-key/i);
  assert.ok(source.includes("platformGet"), "must call platform API");
  assert.ok(source.includes("auth/me"), "must validate against /auth/me");
  assert.match(source, /role.*admin/i, "admin gate required");
});

test("batch routes: all gated on requireBatchIdentity", async () => {
  const tasksRoute = readFileSync(new URL("../../app/api/batch/tasks/route.ts", import.meta.url), "utf8");
  const statusRoute = readFileSync(new URL("../../app/api/batch/tasks/[id]/route.ts", import.meta.url), "utf8");
  const resultRoute = readFileSync(new URL("../../app/api/batch/tasks/[id]/result/route.ts", import.meta.url), "utf8");
  const cancelRoute = readFileSync(new URL("../../app/api/batch/tasks/[id]/cancel/route.ts", import.meta.url), "utf8");

  for (const [name, src] of [
    ["POST/GET tasks", tasksRoute],
    ["GET status", statusRoute],
    ["GET result", resultRoute],
    ["POST cancel", cancelRoute],
  ]) {
    assert.ok(src.includes("requireBatchIdentity"), `${name}: must use batch auth gate`);
    assert.ok(src.includes("isApiRequestAllowed"), `${name}: must check request security`);
  }
});

test("batch task creation: returns 202 with taskId, fire-and-forget", async () => {
  const source = readFileSync(new URL("../../app/api/batch/tasks/route.ts", import.meta.url), "utf8");
  assert.match(source, /status: 202/);
  assert.match(source, /taskId/);
  assert.match(source, /void runBatchTask/);
  assert.match(source, /\.catch/, "fire-and-forget must have a safety net");
});

test("batch runner: auto-responder attaches and stops cleanly", async () => {
  const source = readFileSync(new URL("./task-runner.ts", import.meta.url), "utf8");
  assert.match(source, /attachAutoResponder/);
  assert.match(source, /extension_ui_request/);
  assert.match(source, /inputTimeoutMs/);
  // Auto-responder picks first option (recommended) for select, true for confirm
  assert.match(source, /options\[0\]|options\?\.\[0\]/);
  assert.match(source, /confirmed: true/);
});

test("version info: framework + pi SDK + config bundle versions", async () => {
  const { getBatchVersionInfo } = await import("./version-info.ts");
  const info = getBatchVersionInfo();
  assert.ok(typeof info.frameworkVersion === "string" && info.frameworkVersion.length > 0);
  assert.ok(typeof info.frameworkChannel === "string");
  assert.match(info.piSdkVersion, /^\d+\.\d+\.\d+/);
  // configBundleVersion is string or null (null on dev machines without deployment)
  assert.ok(info.configBundleVersion === null || typeof info.configBundleVersion === "string");
});

test("status and result routes return versions object", async () => {
  const statusSource = readFileSync(new URL("../../app/api/batch/tasks/[id]/route.ts", import.meta.url), "utf8");
  const resultSource = readFileSync(new URL("../../app/api/batch/tasks/[id]/result/route.ts", import.meta.url), "utf8");
  assert.match(statusSource, /getBatchVersionInfo/);
  assert.match(resultSource, /getBatchVersionInfo/);
  assert.match(statusSource, /versions.*getBatchVersionInfo/);
  assert.match(resultSource, /versions.*getBatchVersionInfo/);
});

// ---------------------------------------------------------------------------
// Task event channel (SSE stream backing store)
// ---------------------------------------------------------------------------

const makeRecord = (taskId) => ({
  taskId,
  sessionId: "",
  mode: "host",
  requestedWorkDir: "/tmp/x",
  actualWorkDir: "",
  prompt: "p",
  timeoutMs: 1000,
  inputTimeoutMs: 1000,
  stopContainer: false,
});

test("task events: create/update/terminal publish sequenced stream events", async () => {
  const store = await loadStore();
  store.createTaskRecord(makeRecord("t-ev"));
  const events = [];
  const unsub = store.subscribeTaskEvents("t-ev", (env) => events.push(env));

  store.updateTask("t-ev", { state: "running", startedAt: Date.now() - 5000 });
  store.updateTask("t-ev", { state: "waiting_input" });
  store.updateTask("t-ev", { state: "running" });
  store.updateTask("t-ev", { state: "completed", stopReason: "end_turn", endedAt: Date.now(), finalResponse: "done", summary: "done" });
  unsub();

  // task_created is replayed (subscribed after creation), then live transitions.
  assert.deepEqual(events.map((e) => e.event.type), ["task_created", "status", "status", "status", "status", "result"]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);

  const result = events.at(-1).event;
  assert.equal(result.type, "result");
  assert.equal(result.result.finalResponse, "done");
  assert.equal(result.result.state, "completed");
  assert.ok(result.result.durationMs >= 4000);
  assert.ok(result.versions && typeof result.versions.frameworkVersion === "string");

  // A late subscriber replays the whole channel in order.
  const replay = [];
  store.subscribeTaskEvents("t-ev", (env) => replay.push(env));
  assert.equal(replay.length, 6);
  assert.equal(replay[0].event.type, "task_created");
  assert.equal(replay.at(-1).event.type, "result");
});

test("task events: terminal states are absorbing", async () => {
  const store = await loadStore();
  store.createTaskRecord(makeRecord("t-abs"));
  store.updateTask("t-abs", { state: "running", startedAt: Date.now() });
  store.updateTask("t-abs", { state: "cancelled", stopReason: "cancelled", endedAt: Date.now() });
  // Late runner completion must not resurrect the cancelled task.
  store.updateTask("t-abs", { state: "completed", stopReason: "end_turn", endedAt: Date.now() });
  assert.equal(store.getTask("t-abs").state, "cancelled");

  const events = [];
  store.subscribeTaskEvents("t-abs", (env) => events.push(env));
  assert.deepEqual(events.map((e) => e.event.type), ["task_created", "status", "status", "result"]);
});

test("task events: buffer caps at 500 with truncation flag", async () => {
  const store = await loadStore();
  store.createTaskRecord(makeRecord("t-cap"));
  for (let i = 0; i < 520; i++) {
    store.publishTaskEvent("t-cap", { type: "agent_event", agentEvent: { type: "message_update", i } });
  }
  const info = store.getTaskEventBufferInfo("t-cap");
  assert.equal(info.truncated, true);
  // 521 events published total → buffer holds the last 500 (seq 22..521).
  assert.equal(info.firstSeq, 22);
  const replay = [];
  store.subscribeTaskEvents("t-cap", (env) => replay.push(env));
  assert.equal(replay.length, 500);
  assert.equal(replay[0].seq, 22);
  assert.equal(replay.at(-1).seq, 521);
});

test("batch SSE stream: replays events, forwards live, closes after result", async () => {
  const store = await loadStore();
  const { createBatchTaskEventStream } = await import("./task-event-stream.ts");
  store.createTaskRecord(makeRecord("t-sse"));
  store.updateTask("t-sse", { state: "running", startedAt: Date.now() - 1000 });

  const req = new Request("http://localhost/api/batch/tasks/t-sse/stream");
  const stream = createBatchTaskEventStream("t-sse", req);
  const reader = stream.getReader();

  const chunks = [];
  const readAll = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  })();

  // Live events while the stream is open, then the terminal transition.
  store.publishTaskEvent("t-sse", { type: "agent_event", agentEvent: { type: "message_start" } });
  store.updateTask("t-sse", { state: "completed", stopReason: "end_turn", endedAt: Date.now(), finalResponse: "ok" });
  await readAll;

  const dataLines = chunks.join("").split("\n\n").filter((l) => l.startsWith("data: "));
  const events = dataLines.map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(events.map((e) => e.event.type), ["task_created", "status", "agent_event", "status", "result"]);
  assert.equal(events.at(-1).event.result.finalResponse, "ok");
  // Heartbeat comment frames must not leak into the data events.
  assert.ok(chunks[0].startsWith(":"));
});

test("batch SSE stream: unknown task emits error and closes", async () => {
  const { createBatchTaskEventStream } = await import("./task-event-stream.ts");
  const stream = createBatchTaskEventStream("nope", new Request("http://localhost/"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /Task not found/);
});

test("batch SSE routes: stream mode + attach endpoint gated", async () => {
  const tasksRoute = readFileSync(new URL("../../app/api/batch/tasks/route.ts", import.meta.url), "utf8");
  assert.match(tasksRoute, /stream === true/);
  assert.match(tasksRoute, /createBatchTaskEventStream/);
  assert.ok(tasksRoute.includes("text/event-stream") || tasksRoute.includes("batchSseHeaders"));

  const streamRoute = readFileSync(new URL("../../app/api/batch/tasks/[id]/stream/route.ts", import.meta.url), "utf8");
  assert.ok(streamRoute.includes("requireBatchIdentity"), "stream route must use batch auth gate");
  assert.ok(streamRoute.includes("isApiRequestAllowed"), "stream route must check request security");
});

test("batch runner: forwards agent events and tracks waiting_input", async () => {
  const source = readFileSync(new URL("./task-runner.ts", import.meta.url), "utf8");
  assert.match(source, /toClientAgentEvent/);
  assert.match(source, /publishTaskEvent/);
  assert.match(source, /"waiting_input"/);
  assert.match(source, /agent_event/);
});
