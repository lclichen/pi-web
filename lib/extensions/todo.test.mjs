import assert from "node:assert/strict";
import test from "node:test";

/**
 * P0-1 contract tests for the v2 todo extension (full-list write semantics).
 *
 * These run model-free (the "framework slice" of the benchmark layering in
 * bench/README.md): they pin the tool contract that makes the tool easy for
 * models to use — set-not-flip statuses, stable ids, self-correcting errors,
 * anti-loop no-op detection, and branch-safe replay.
 */

async function loadSubject() {
  return import("./todo.ts");
}

async function loadProtocol() {
  return import("./todo-protocol.ts");
}

/** Capture-style mock of the pi ExtensionAPI surface the extension uses. */
async function loadExtension() {
  const mod = await loadSubject();
  const tools = [];
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const pi = {
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, def) => commands.set(name, def),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType, data) => appended.push({ customType, data }),
  };
  mod.makeTodoExtension()(pi);
  assert.equal(tools.length, 1, "exactly one tool registered");
  return { mod, pi, tool: tools[0], commands, handlers, appended };
}

function makeCtx({ branch = [] } = {}) {
  const widgets = new Map();
  const ctx = {
    cwd: "/tmp/todo-test",
    ui: { setWidget: (key, lines) => widgets.set(key, lines) },
    sessionManager: { getBranch: () => branch },
  };
  return { ctx, widgets };
}

const textOf = (result) =>
  result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

async function run(tool, ctx, todos) {
  return tool.execute("call-1", { todos }, undefined, undefined, ctx);
}

const step = (content, status = "pending", activeForm) =>
  activeForm === undefined ? { content, status } : { content, status, activeForm };

test("registers the todo tool with prompt guidance attached", async () => {
  const { tool } = await loadExtension();
  assert.equal(tool.name, "todo");
  assert.ok(tool.description.length > 40, "description must explain full-list semantics");
  assert.match(tool.description, /COMPLETE/i);
  assert.ok(typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0);
  assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 3);
  assert.ok(
    tool.promptGuidelines.some((g) => g.includes("in_progress")),
    "guidelines must teach the in_progress discipline",
  );
});

test("creating a list assigns ids and echoes the stored list", async () => {
  const { tool } = await loadExtension();
  const { ctx, widgets } = makeCtx();
  const result = await run(tool, ctx, [
    step("Write the parser"),
    step("Run the tests", "in_progress", "running the tests"),
    step("Update the docs"),
  ]);
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /#1 Write the parser/);
  assert.match(textOf(result), /#2 Run the tests/);
  assert.match(textOf(result), /#3 Update the docs/);
  assert.match(textOf(result), /\[>\] #2/);
  assert.deepEqual(
    result.details.todos.map((t) => t.status),
    ["pending", "in_progress", "pending"],
  );
  // Widget published with the protocol payload and parses back identically.
  const { TODO_WIDGET_KEY, parseTodoWidgetLine } = await loadProtocol();
  assert.ok(widgets.has(TODO_WIDGET_KEY));
  const parsed = parseTodoWidgetLine(widgets.get(TODO_WIDGET_KEY)[0]);
  assert.deepEqual(parsed, result.details.todos);
});

test("statuses are SET on full rewrite, ids stay stable across rewrites", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  await run(tool, ctx, [
    step("Write the parser"),
    step("Run the tests", "in_progress"),
    step("Update the docs"),
  ]);
  const result = await run(tool, ctx, [
    step("Write the parser", "completed"),
    step("Run the tests", "completed"),
    step("Update the docs", "in_progress", "updating the docs"),
  ]);
  assert.equal(result.isError, undefined);
  const byContent = Object.fromEntries(result.details.todos.map((t) => [t.content, t.id]));
  // Same content kept its id even though the whole list was replaced.
  assert.equal(byContent["Write the parser"], 1);
  assert.equal(byContent["Run the tests"], 2);
  assert.equal(byContent["Update the docs"], 3);
  assert.match(textOf(result), /2\/3 done/);
});

test("a brand-new step after a rewrite gets a fresh id", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  await run(tool, ctx, [step("A"), step("B")]);
  const result = await run(tool, ctx, [step("A", "completed"), step("C")]);
  const byContent = Object.fromEntries(result.details.todos.map((t) => [t.content, t.id]));
  assert.equal(byContent.A, 1);
  assert.equal(byContent.C, 3, "new content must not reuse the dropped id 2");
});

test("more than one in_progress is an in-band error that keeps state unchanged", async () => {
  const { tool } = await loadExtension();
  const { ctx, widgets } = makeCtx();
  await run(tool, ctx, [step("A"), step("B")]);
  const widgetBefore = widgets.get("todo-list");
  const result = await run(tool, ctx, [step("A", "in_progress"), step("B", "in_progress")]);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /exactly one step may be in_progress/i);
  assert.match(textOf(result), /Current list \(unchanged\)/i);
  assert.deepEqual(
    result.details.todos.map((t) => t.status),
    ["pending", "pending"],
    "rejected write must not mutate state",
  );
  assert.deepEqual(widgets.get("todo-list"), widgetBefore, "widget payload unchanged on error");
});

test("verbatim rewrite returns No change (anti-loop guard)", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  await run(tool, ctx, [step("A", "in_progress"), step("B")]);
  const result = await run(tool, ctx, [step("A", "in_progress"), step("B")]);
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /No change/);
  assert.equal(result.details.noChange, true);
});

test("completing every step auto-clears the list and hides the widget", async () => {
  const { tool } = await loadExtension();
  const { ctx, widgets } = makeCtx();
  const { TODO_WIDGET_KEY } = await loadProtocol();
  await run(tool, ctx, [step("A"), step("B")]);
  const result = await run(tool, ctx, [step("A", "completed"), step("B", "completed")]);
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /All 2 steps completed — list cleared/);
  assert.deepEqual(result.details.todos, []);
  assert.equal(widgets.get(TODO_WIDGET_KEY), undefined, "empty list unpublishes the widget");
});

test("sending an empty array clears the list", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  await run(tool, ctx, [step("A")]);
  const result = await run(tool, ctx, []);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.todos, []);
});

test("duplicate step content is rejected without mutating state", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  await run(tool, ctx, [step("A")]);
  const result = await run(tool, ctx, [step("A"), step("A")]);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /duplicate/i);
  assert.equal(result.details.todos.length, 1);
});

test("empty step content is rejected", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  const result = await run(tool, ctx, [step("   ")]);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /non-empty content/i);
});

test("oversized lists are rejected", async () => {
  const { tool } = await loadExtension();
  const { ctx } = makeCtx();
  const many = Array.from({ length: 31 }, (_, i) => step(`Step ${i + 1}`));
  const result = await run(tool, ctx, many);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /max 30/i);
});

test("session_start replays v2 tool-result snapshots from the branch", async () => {
  const { handlers } = await loadExtension();
  const { TODO_WIDGET_KEY, parseTodoWidgetLine } = await loadProtocol();
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, content: "A", status: "pending" }], nextId: 2 } } },
    { type: "message", message: { role: "toolResult", toolName: "other", details: {} } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: { todos: [{ id: 1, content: "A", status: "completed" }, { id: 2, content: "B", status: "in_progress", activeForm: "doing B" }], nextId: 3 },
      },
    },
  ];
  const { ctx, widgets } = makeCtx({ branch });
  await handlers.get("session_start")[0]({}, ctx);
  const parsed = parseTodoWidgetLine(widgets.get(TODO_WIDGET_KEY)[0]);
  assert.deepEqual(parsed, [
    { id: 1, content: "A", status: "completed" },
    { id: 2, content: "B", status: "in_progress", activeForm: "doing B" },
  ]);
});

test("session_start migrates legacy v1 details ({text, done}) on replay", async () => {
  const { handlers, tool } = await loadExtension();
  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: { action: "add", todos: [{ id: 1, text: "旧任务", done: true }, { id: 2, text: "未完任务", done: false }], nextId: 3 },
      },
    },
  ];
  const { ctx } = makeCtx({ branch });
  await handlers.get("session_start")[0]({}, ctx);
  // Continue working on the migrated session: full rewrite keeps the old ids.
  const result = await run(tool, ctx, [
    { content: "旧任务", status: "completed" },
    { content: "未完任务", status: "in_progress" },
  ]);
  const byContent = Object.fromEntries(result.details.todos.map((t) => [t.content, t.id]));
  assert.equal(byContent["旧任务"], 1);
  assert.equal(byContent["未完任务"], 2);
});

test("a todo-clear custom entry wins over earlier snapshots on replay", async () => {
  const { handlers, commands, appended } = await loadExtension();
  const { TODO_WIDGET_KEY } = await loadProtocol();
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, content: "A", status: "pending" }], nextId: 2 } } },
  ];
  const { ctx, widgets } = makeCtx({ branch });
  await handlers.get("session_start")[0]({}, ctx);
  assert.ok(widgets.get(TODO_WIDGET_KEY), "widget visible after replay");

  // User runs /todo-clear: state clears now, a custom entry records it for
  // future replays, and the widget hides.
  await commands.get("todo-clear").handler("", ctx);
  assert.equal(widgets.get(TODO_WIDGET_KEY), undefined);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].customType, "todo-clear");

  const branchAfterClear = [
    ...branch,
    { type: "custom", customType: "todo-clear" },
  ];
  const { ctx: ctx2, widgets: widgets2 } = makeCtx({ branch: branchAfterClear });
  await handlers.get("session_start")[0]({}, ctx2);
  assert.equal(widgets2.get(TODO_WIDGET_KEY), undefined, "replay after clear stays empty");
});

test("session_tree also rebuilds from the branch (branch switch)", async () => {
  const { handlers } = await loadExtension();
  const { TODO_WIDGET_KEY, parseTodoWidgetLine } = await loadProtocol();
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, content: "branched step", status: "in_progress" }], nextId: 2 } } },
  ];
  const { ctx, widgets } = makeCtx({ branch });
  await handlers.get("session_tree")[0]({}, ctx);
  assert.equal(parseTodoWidgetLine(widgets.get(TODO_WIDGET_KEY)[0])[0].content, "branched step");
});

test("protocol: parseTodoWidgetLine is defensive against malformed payloads", async () => {
  const { parseTodoWidgetLine } = await loadProtocol();
  assert.deepEqual(parseTodoWidgetLine(undefined), []);
  assert.deepEqual(parseTodoWidgetLine(""), []);
  assert.deepEqual(parseTodoWidgetLine("not json"), []);
  assert.deepEqual(parseTodoWidgetLine(JSON.stringify({})), []);
  assert.deepEqual(parseTodoWidgetLine(JSON.stringify({ todos: "nope" })), []);
  assert.deepEqual(
    parseTodoWidgetLine(JSON.stringify({ todos: [{ id: 1, content: "ok" }, { id: "x", content: 5 }, null] })),
    [{ id: 1, content: "ok", status: "pending" }],
    "invalid items are skipped, valid ones survive",
  );
  // Unknown status degrades to pending rather than breaking the UI.
  assert.deepEqual(
    parseTodoWidgetLine(JSON.stringify({ todos: [{ id: 2, content: "s", status: "weird" }] })),
    [{ id: 2, content: "s", status: "pending" }],
  );
});

test("protocol: encode/parse roundtrip preserves every field", async () => {
  const { encodeTodoWidget, parseTodoWidgetLine } = await loadProtocol();
  const todos = [
    { id: 1, content: "A", status: "completed" },
    { id: 2, content: "B", status: "in_progress", activeForm: "working on B" },
  ];
  assert.deepEqual(parseTodoWidgetLine(encodeTodoWidget(todos)), todos);
});
