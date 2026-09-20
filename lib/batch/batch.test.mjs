import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Batch test infrastructure: task store + utils (pure, no rpc deps). */

const resetStore = () => {
  globalThis.__piWebBatchTasks = undefined;
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
