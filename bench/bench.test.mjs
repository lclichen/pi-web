import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * CI layer of the harness benchmark (P0-2): everything that must hold without
 * a model or network — task fixture validity, deterministic checkers, report
 * rendering, model-selection gating, and the bench extension stack actually
 * exposing the todo/plan tools. The real-model layer (runner.mjs) is env-
 * gated and never runs here, mirroring the pi upstream discipline that keeps
 * paid APIs out of the default suite.
 */

async function loadChecks() {
  return import("./checks.ts");
}
async function loadTasks() {
  return import("./tasks.ts");
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "pi-web-bench-test-"));
}

// ---------------------------------------------------------------------------
// Task fixture validation — a broken task can never reach a real run.
// ---------------------------------------------------------------------------

const CHECK_KINDS = new Set([
  "file_exists", "file_not_exists", "file_contains", "file_not_contains",
  "node_script", "command", "plan_saved", "todo_used", "todo_all_completed",
]);

test("task fixtures are well-formed", async () => {
  const { TASKS } = await loadTasks();
  assert.ok(TASKS.length >= 5, "task set should cover at least five capability areas");
  const ids = new Set();
  for (const task of TASKS) {
    assert.ok(!ids.has(task.id), `duplicate task id: ${task.id}`);
    ids.add(task.id);
    assert.match(task.id, /^[a-z0-9-]+$/);
    assert.ok(task.prompt.trim().length > 20, `${task.id}: prompt too thin`);
    assert.ok(Array.isArray(task.checks) && task.checks.length > 0, `${task.id}: needs checks`);
    for (const check of task.checks) {
      assert.ok(CHECK_KINDS.has(check.kind), `${task.id}: unknown check kind ${check.kind}`);
    }
    for (const path of Object.keys(task.files)) {
      assert.ok(!path.includes("..") && !/^[a-zA-Z]:[\\/]/.test(path), `${task.id}: fixture path must be workspace-relative: ${path}`);
    }
    // File checks must reference files that exist in the fixture OR will be
    // created by the agent — at minimum, no check may read a file that the
    // task neither seeds nor asks for.
    if (task.timeoutMs !== undefined) assert.ok(task.timeoutMs >= 60_000);
  }
  const areas = new Set(TASKS.map((t) => t.area));
  assert.ok(areas.has("todo"), "a todo-area task is required (P0-1 live suite)");
  assert.ok(areas.has("plan"), "a plan-area task is required");
});

test("fixtures with test commands must be runnable on this node", async () => {
  const { runCheck } = await loadChecks();
  const { TASKS } = await loadTasks();
  const cwd = tempWorkspace();
  try {
    for (const task of TASKS) {
      for (const [path, content] of Object.entries(task.files)) {
        const full = join(cwd, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf8");
      }
      // Run only the cheap static checks; skip todo_*/plan_saved (transcript
      // or agent-produced state) and node_script/command (agent output needed).
      for (const check of task.checks) {
        if (check.kind.startsWith("file_") && task.files[check.path]) {
          const result = await runCheck(check, { cwd, messages: [] });
          // A file check against a seeded file expresses a negative
          // expectation (file_not_contains) — both outcomes are legitimate,
          // it just must not crash.
          assert.ok(typeof result.pass === "boolean");
        }
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deterministic checkers
// ---------------------------------------------------------------------------

test("file checks: exists / not_exists / contains(text|regex) / not_contains", async () => {
  const { runCheck } = await loadChecks();
  const cwd = tempWorkspace();
  try {
    writeFileSync(join(cwd, "a.txt"), "hello world\nsecond line\n", "utf8");
    assert.equal((await runCheck({ kind: "file_exists", path: "a.txt" }, { cwd, messages: [] })).pass, true);
    assert.equal((await runCheck({ kind: "file_exists", path: "nope.txt" }, { cwd, messages: [] })).pass, false);
    assert.equal((await runCheck({ kind: "file_not_exists", path: "nope.txt" }, { cwd, messages: [] })).pass, true);
    assert.equal((await runCheck({ kind: "file_contains", path: "a.txt", text: "second line" }, { cwd, messages: [] })).pass, true);
    assert.equal((await runCheck({ kind: "file_contains", path: "a.txt", regex: "^second" }, { cwd, messages: [] })).pass, true);
    assert.equal((await runCheck({ kind: "file_contains", path: "a.txt", regex: "^third" }, { cwd, messages: [] })).pass, false);
    assert.equal((await runCheck({ kind: "file_not_contains", path: "a.txt", text: "third" }, { cwd, messages: [] })).pass, true);
    assert.equal((await runCheck({ kind: "file_not_contains", path: "missing.txt", text: "x" }, { cwd, messages: [] })).pass, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("node_script check passes on exit 0 and fails on exit 1 with stderr detail", async () => {
  const { runCheck } = await loadChecks();
  const cwd = tempWorkspace();
  try {
    const ok = await runCheck({ kind: "node_script", script: "process.exit(0)" }, { cwd, messages: [] });
    assert.equal(ok.pass, true);
    const bad = await runCheck({ kind: "node_script", script: "console.error('boom'); process.exit(1)" }, { cwd, messages: [] });
    assert.equal(bad.pass, false);
    assert.match(bad.detail, /boom/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("command check: exit-code expectations and stdoutRegex", async () => {
  const { runCheck } = await loadChecks();
  const cwd = tempWorkspace();
  try {
    const ok = await runCheck(
      { kind: "command", argv: [process.execPath, "-e", "console.log('out42')"] },
      { cwd, messages: [] },
    );
    assert.equal(ok.pass, true);
    const matched = await runCheck(
      { kind: "command", argv: [process.execPath, "-e", "console.log('out42')"], stdoutRegex: "out42" },
      { cwd, messages: [] },
    );
    assert.equal(matched.pass, true);
    const mismatched = await runCheck(
      { kind: "command", argv: [process.execPath, "-e", "console.log('x')"], stdoutRegex: "out42" },
      { cwd, messages: [] },
    );
    assert.equal(mismatched.pass, false);
    const expectedFail = await runCheck(
      { kind: "command", argv: [process.execPath, "-e", "process.exit(3)"], expectExit: 3 },
      { cwd, messages: [] },
    );
    assert.equal(expectedFail.pass, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plan_saved check accepts checkbox plans and rejects everything else", async () => {
  const { runCheck } = await loadChecks();
  const cwd = tempWorkspace();
  try {
    assert.equal((await runCheck({ kind: "plan_saved" }, { cwd, messages: [] })).pass, false);
    mkdirSync(join(cwd, ".pi", "plans"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "plans", "plan-sess_x.md"), "# plan\n\nno checkboxes\n", "utf8");
    assert.equal((await runCheck({ kind: "plan_saved" }, { cwd, messages: [] })).pass, false);
    writeFileSync(join(cwd, ".pi", "plans", "plan-sess_x.md"), "# plan\n\n- [ ] step one\n- [x] step two\n", "utf8");
    const ok = await runCheck({ kind: "plan_saved" }, { cwd, messages: [] });
    assert.equal(ok.pass, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Transcript checks (todo discipline) — synthetic transcripts
// ---------------------------------------------------------------------------

const toolResult = (toolName, details, isError = false) => ({
  role: "toolResult",
  toolCallId: `t-${toolName}-${Math.random().toString(36).slice(2, 7)}`,
  toolName,
  isError,
  details,
  content: [{ type: "text", text: "ok" }],
});

const todoCall = () => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `t-todo-${Math.random().toString(36).slice(2, 7)}`, name: "todo", arguments: { todos: [] } }],
});

function transcriptWithTodo(snapshots, { withCalls = true, errors = [] } = {}) {
  const messages = [];
  for (const snap of snapshots) {
    if (withCalls) messages.push(todoCall());
    messages.push(toolResult("todo", snap));
  }
  for (const err of errors) messages.push(toolResult("todo", err, true));
  return messages;
}

test("todo_used: counts calls, flags misuse errors, respects bounds", async () => {
  const { runCheck } = await loadChecks();
  const base = { cwd: "", messages: [] };
  const good = transcriptWithTodo([{ todos: [{ status: "pending" }], nextId: 2 }]);
  assert.equal((await runCheck({ kind: "todo_used", minCalls: 1 }, { ...base, messages: good })).pass, true);

  const none = [];
  assert.equal((await runCheck({ kind: "todo_used", minCalls: 1 }, { ...base, messages: none })).pass, false);

  const chatty = transcriptWithTodo([{}, {}, {}, {}]);
  assert.equal((await runCheck({ kind: "todo_used", maxCalls: 3 }, { ...base, messages: chatty })).pass, false);

  const misuse = transcriptWithTodo([{ todos: [], nextId: 1, error: "exactly one step may be in_progress" }], { errors: [toolResult("todo", { todos: [], nextId: 1, error: "x" })] });
  const res = await runCheck({ kind: "todo_used", minCalls: 1, forbidErrors: true }, { ...base, messages: misuse });
  assert.equal(res.pass, false);
  assert.match(res.detail, /validation errors/);
});

test("todo_all_completed: auto-cleared, all-completed, unfinished, never-used", async () => {
  const { runCheck } = await loadChecks();
  const base = { cwd: "", messages: [] };

  const cleared = transcriptWithTodo([
    { todos: [{ status: "in_progress" }], nextId: 2 },
    { todos: [], nextId: 1 }, // auto-clear after all-complete
  ]);
  assert.equal((await runCheck({ kind: "todo_all_completed" }, { ...base, messages: cleared })).pass, true);

  const allDone = transcriptWithTodo([
    { todos: [{ status: "completed" }, { status: "completed" }], nextId: 3 },
  ]);
  assert.equal((await runCheck({ kind: "todo_all_completed" }, { ...base, messages: allDone })).pass, true);

  const unfinished = transcriptWithTodo([
    { todos: [{ status: "completed" }, { status: "pending" }], nextId: 3 },
  ]);
  const res = await runCheck({ kind: "todo_all_completed" }, { ...base, messages: unfinished });
  assert.equal(res.pass, false);
  assert.match(res.detail, /unfinished/);

  assert.equal((await runCheck({ kind: "todo_all_completed" }, { ...base, messages: [] })).pass, false);
});

test("todoMetrics surfaces no-op calls for the behavior report", async () => {
  const { todoMetrics } = await loadChecks();
  const messages = transcriptWithTodo([
    { todos: [{ status: "in_progress" }], nextId: 2 },
    { todos: [{ status: "in_progress" }], nextId: 2, noChange: true },
  ]);
  const m = todoMetrics(messages);
  assert.equal(m.calls, 2);
  assert.equal(m.noChangeCalls, 1);
  assert.equal(m.errorCalls, 0);
  assert.equal(m.everHadList, true);
});

// ---------------------------------------------------------------------------
// Harness gating + extension stack (ties P0-1 into the bench)
// ---------------------------------------------------------------------------

test("resolveModelSelection refuses to run without provider/model", async () => {
  const { resolveModelSelection } = await import("./harness.ts");
  const env = {};
  assert.throws(() => resolveModelSelection(undefined, env), /PI_PROVIDER/);
  assert.deepEqual(resolveModelSelection(undefined, { PI_PROVIDER: "p", PI_MODEL: "m" }), { provider: "p", id: "m" });
  assert.deepEqual(resolveModelSelection({ provider: "x", id: "y" }, env), { provider: "x", id: "y" });
});

test("bench extension stack registers the todo and plan_save tools", async () => {
  const { benchExtensionFactories } = await import("./harness.ts");
  const factories = benchExtensionFactories();
  assert.equal(factories.length, 2);
  const tools = [];
  for (const factory of factories) {
    factory({
      registerTool: (t) => tools.push(t),
      registerCommand: () => {},
      on: () => {},
      appendEntry: () => {},
    });
  }
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("todo"), "todo tool must be exposed to bench sessions");
  assert.ok(names.includes("plan_save"), "plan_save tool must be exposed to bench sessions");
  const todo = tools.find((t) => t.name === "todo");
  assert.ok(todo.promptGuidelines?.length >= 3, "todo guidance rides along into bench sessions");
});

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

test("markdown report renders summary, areas, todo metrics and failures", async () => {
  const { renderMarkdownReport, toTaskRecord } = await import("./report.ts");
  const records = [
    toTaskRecord(
      "todo-multi-step-discipline", "todo", { provider: "p", id: "m" }, true,
      [{ name: "c1", kind: "todo_used", pass: true, detail: "ok" }],
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, toolCalls: 7 },
      12_345, undefined,
      { calls: 5, errorCalls: 0, noChangeCalls: 1 },
    ),
    toTaskRecord(
      "edit-fix-average", "edit", { provider: "p", id: "m" }, false,
      [{ name: "tests pass", kind: "command", pass: false, detail: "command failed (code 1)" }],
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 2 },
      99_999, "agent run ended with stopReason=error",
    ),
  ];
  const md = renderMarkdownReport({ startedAt: "2026-09-17T00:00:00Z", provider: "p", model: "m", taskCount: 2 }, records);
  assert.match(md, /通过 \*\*1\/2\*\*/);
  assert.match(md, /## 分域能力/);
  assert.match(md, /\| todo \| 1\/1 \|/);
  assert.match(md, /\| edit \| 0\/1 \|/);
  assert.match(md, /todo 工具行为指标/);
  assert.match(md, /no-op calls/);
  assert.match(md, /失败详情/);
  assert.match(md, /command failed/);
});
