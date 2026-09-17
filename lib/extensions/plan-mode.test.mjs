import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Plan-mode contract tests (harness-research/01 方案的 Phase 1+2 落地验证):
 * 状态机与回放、工具门禁矩阵（写工具/变异 shell/todo 阻断，只读与
 * plan_save/子智能体放行）、进入/退出工具行为、确认流永不失败、
 * before_agent_start 注入、widget 发布。
 */

async function loadSubject() {
  return import("./plan-mode.ts");
}

async function loadExtension() {
  const mod = await loadSubject();
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const appended = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, def) => commands.set(name, def),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType, data) => appended.push({ customType, data }),
  };
  mod.makePlanModeExtension()(pi);
  return { mod, pi, tools, commands, handlers, appended };
}

function makeCtx({ branch = [], planFile = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-mode-test-"));
  if (planFile) {
    mkdirSync(join(cwd, ".pi", "plans"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "plans", "plan-sess_sess-1.md"), "# 计划\n\n- [ ] 步骤一\n", "utf8");
  }
  const widgets = new Map();
  const notifications = [];
  const compactions = [];
  let selectImpl = null;
  const ctx = {
    cwd,
    ui: {
      setWidget: (key, lines) => widgets.set(key, lines),
      notify: (message) => notifications.push(message),
      select: undefined,
    },
    compact: () => compactions.push(Date.now()),
    sessionManager: { getBranch: () => branch, getSessionId: () => "sess-1" },
  };
  // Tests can install a select implementation to simulate the host UI.
  Object.defineProperty(ctx.ui, "select", {
    configurable: true,
    get: () => selectImpl,
    set: (v) => { selectImpl = v; },
  });
  return { ctx, widgets, notifications, compactions, cwd };
}

const call = (handler, event) => handler(event, { systemPromptReplacedByHandlerChain: undefined });

async function toolCall(tools, name, params, ctx) {
  return tools.get(name).execute("t1", params ?? {}, undefined, undefined, ctx);
}

test("registers both mode tools and manual commands with prompt guidance", async () => {
  const { tools, commands } = await loadExtension();
  assert.ok(tools.has("enter_plan_mode") && tools.has("exit_plan_mode"));
  assert.ok(commands.has("plan") && commands.has("plan-exit"));
  const enter = tools.get("enter_plan_mode");
  assert.ok(enter.promptGuidelines.length >= 2, "entry conditions must be taught");
  assert.match(enter.promptGuidelines.join("\n"), /多文件|架构|高风险|3 步/);
  assert.ok(tools.get("exit_plan_mode").promptGuidelines.length >= 1);
});

test("enter_plan_mode switches state, persists an entry and publishes the widget", async () => {
  const { tools, appended } = await loadExtension();
  const { ctx, widgets } = makeCtx();
  const result = await toolCall(tools, "enter_plan_mode", {}, ctx);
  assert.match(result.content[0].text, /Entered PLAN mode/);
  assert.deepEqual(appended.map((e) => e.customType), ["plan-mode"]);
  assert.equal(appended[0].data.mode, "plan");
  assert.deepEqual(JSON.parse(widgets.get("plan-mode")[0]), { mode: "plan" });
  // Idempotent re-entry does not append duplicate entries.
  await toolCall(tools, "enter_plan_mode", {}, ctx);
  assert.equal(appended.length, 1);
});

test("execute mode: mutating tools pass through untouched", async () => {
  const { handlers } = await loadExtension();
  const gate = handlers.get("tool_call")[0];
  assert.equal(await call(gate, { type: "tool_call", toolCallId: "t", toolName: "write", input: { path: "a" } }), undefined);
  assert.equal(await call(gate, { type: "tool_call", toolCallId: "t", toolName: "bash", input: { command: "rm -rf /" } }), undefined);
});

test("plan mode gating matrix: blocked vs allowed", async () => {
  const { tools, handlers } = await loadExtension();
  const gate = handlers.get("tool_call")[0];
  const { ctx } = makeCtx();
  await toolCall(tools, "enter_plan_mode", {}, ctx);

  const blocked = async (event) => {
    const r = await call(gate, { type: "tool_call", toolCallId: "t", ...event });
    assert.ok(r?.block === true, `${event.toolName} should be blocked`);
    assert.ok(typeof r.reason === "string" && r.reason.length > 10);
  };
  await blocked({ toolName: "write", input: { path: "x", content: "y" } });
  await blocked({ toolName: "edit", input: { path: "x" } });
  await blocked({ toolName: "todo", input: { todos: [] } });
  await blocked({ toolName: "bash", input: { command: "rm -rf build" } });
  await blocked({ toolName: "bash", input: { command: "echo hi > out.txt" } });
  await blocked({ toolName: "bash", input: { command: "git commit -m x" } });
  await blocked({ toolName: "bash", input: { command: "npm install left-pad" } });
  await blocked({ toolName: "powershell", input: { command: "Remove-Item -Recurse build" } });

  const allowed = async (event) => {
    assert.equal(await call(gate, { type: "tool_call", toolCallId: "t", ...event }), undefined, `${event.toolName} ${JSON.stringify(event.input)} should be allowed`);
  };
  await allowed({ toolName: "read", input: { path: "x" } });
  await allowed({ toolName: "ls", input: { path: "." } });
  await allowed({ toolName: "grep", input: { pattern: "x" } });
  await allowed({ toolName: "find", input: { pattern: "x" } });
  await allowed({ toolName: "plan_save", input: { content: "# p" } });
  await allowed({ toolName: "Agent", input: { prompt: "explore" } });
  await allowed({ toolName: "enter_plan_mode", input: {} });
  await allowed({ toolName: "exit_plan_mode", input: {} });
  // Read-only shell idioms stay usable while planning.
  await allowed({ toolName: "bash", input: { command: "ls -la && grep -rn foo src/" } });
  await allowed({ toolName: "bash", input: { command: "cat log 2>/dev/null" } });
  await allowed({ toolName: "bash", input: { command: "node --version" } });
  await allowed({ toolName: "bash", input: { command: "git log --oneline -5" } });
});

test("before_agent_start injects the mode block only while planning", async () => {
  const { tools, handlers } = await loadExtension();
  const inject = handlers.get("before_agent_start")[0];
  const { ctx } = makeCtx();
  const base = { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} };
  assert.equal(await call(inject, base), undefined, "execute mode leaves the prompt untouched");
  await toolCall(tools, "enter_plan_mode", {}, ctx);
  const result = await call(inject, base);
  assert.match(result.systemPrompt, /^BASE\n<collaboration_mode>/);
  assert.match(result.systemPrompt, /PLAN mode/);
  assert.match(result.systemPrompt, /<\/collaboration_mode>/);
});

test("exit_plan_mode requires plan mode AND a saved plan", async () => {
  const { tools } = await loadExtension();
  const { ctx } = makeCtx();
  // Not in plan mode.
  const outside = await toolCall(tools, "exit_plan_mode", {}, ctx);
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /Not in PLAN mode/);

  // In plan mode without a saved plan.
  const enterTool = tools.get("enter_plan_mode");
  await enterTool.execute("t", {}, undefined, undefined, ctx);
  const noPlan = await toolCall(tools, "exit_plan_mode", {}, ctx);
  assert.equal(noPlan.isError, true);
  assert.match(noPlan.content[0].text, /No plan saved yet/);
});

test("exit_plan_mode approval flow: approve switches mode with todo handoff", async () => {
  const { tools, appended } = await loadExtension();
  const { ctx, widgets, compactions } = makeCtx({ planFile: true });
  await tools.get("enter_plan_mode").execute("t", {}, undefined, undefined, ctx);
  ctx.ui.select = async () => "直接实施";
  const result = await tools.get("exit_plan_mode").execute("t", { summary: "方案A" }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /approved the plan/);
  assert.match(result.content[0].text, /todo list/);
  assert.equal(result.details.freshContext, undefined);
  assert.equal(compactions.length, 0, "plain approval does not compact");
  assert.deepEqual(JSON.parse(widgets.get("plan-mode")[0]), { mode: "execute" });
  assert.equal(appended[appended.length - 1].data.mode, "execute");
  rmSync(ctx.cwd, { recursive: true, force: true });
});

test("exit_plan_mode fresh-context choice compacts and hands off plan-as-source", async () => {
  const { tools } = await loadExtension();
  const { ctx, compactions } = makeCtx({ planFile: true });
  await tools.get("enter_plan_mode").execute("t", {}, undefined, undefined, ctx);
  ctx.ui.select = async () => "清上下文实施";
  const result = await tools.get("exit_plan_mode").execute("t", {}, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.freshContext, true);
  assert.equal(compactions.length, 1, "fresh-context choice triggers compaction");
  assert.match(result.content[0].text, /FRESH context/);
  assert.match(result.content[0].text, /source of user intent/);
  rmSync(ctx.cwd, { recursive: true, force: true });
});

test("exit_plan_mode never fails: decline / timeout / throwing UI / missing UI", async () => {
  const { tools } = await loadExtension();

  const ask = async (selectImpl) => {
    const { ctx } = makeCtx({ planFile: true });
    await tools.get("enter_plan_mode").execute("t", {}, undefined, undefined, ctx);
    ctx.ui.select = selectImpl;
    const result = await tools.get("exit_plan_mode").execute("t", {}, undefined, undefined, ctx);
    rmSync(ctx.cwd, { recursive: true, force: true });
    return result;
  };

  const refused = await ask(async () => "继续规划");
  assert.equal(refused.isError, undefined, "decline is not an error");
  assert.match(refused.content[0].text, /仍在 PLAN 模式/);

  const timedOut = await ask(async () => undefined); // select resolved nothing
  assert.match(timedOut.content[0].text, /仍在 PLAN 模式/);

  // Headless host (no select at all): auto-approve so the workflow cannot
  // dead-lock — the handoff proceeds with an explicit note.
  const headless = await ask(undefined);
  assert.match(headless.content[0].text, /无交互确认 UI，自动批准/);
  assert.match(headless.content[0].text, /approved the plan/);

  // SDK no-op UI trap: select IS a callable function there (silently
  // declining) — ctx.hasUI === false is the real headless signal.
  {
    const { tools: t2 } = await loadExtension();
    const { ctx } = makeCtx({ planFile: true });
    await t2.get("enter_plan_mode").execute("t", {}, undefined, undefined, ctx);
    ctx.hasUI = false;
    ctx.ui.select = async () => undefined; // SDK noOp-style: callable, declines
    const result = await t2.get("exit_plan_mode").execute("t", {}, undefined, undefined, ctx);
    assert.match(result.content[0].text, /无交互确认 UI，自动批准/, "hasUI=false must override the callable-but-fake select");
    assert.match(result.content[0].text, /approved the plan/);
    rmSync(ctx.cwd, { recursive: true, force: true });
  }

  const threw = await ask(async () => { throw new Error("host UI exploded"); });
  assert.equal(threw.isError, undefined, "host UI exceptions must not propagate");
  assert.match(threw.content[0].text, /确认框异常/);
});

test("manual commands switch modes and replay restores from the branch", async () => {
  const { mod, commands, handlers, appended } = await loadExtension();
  const { ctx, widgets } = makeCtx();
  await commands.get("plan").handler("", ctx);
  assert.deepEqual(JSON.parse(widgets.get("plan-mode")[0]), { mode: "plan" });

  // Replay: branch with plan → execute entries; last wins.
  const branch = [
    { type: "custom", customType: "plan-mode", data: { mode: "plan" } },
    { type: "custom", customType: "unrelated", data: {} },
    { type: "custom", customType: "plan-mode", data: { mode: "execute" } },
    { type: "custom", customType: "plan-mode", data: { mode: "plan" } },
  ];
  assert.equal(mod.reconstructPlanMode(branch), "plan");
  assert.equal(mod.reconstructPlanMode([]), "execute");
  assert.equal(mod.reconstructPlanMode([{ type: "custom", customType: "plan-mode", data: { mode: "bogus" } }]), "execute");

  // session_start restores and publishes the replayed mode.
  const restoreCtx = makeCtx({ branch });
  await handlers.get("session_start")[0]({}, restoreCtx.ctx);
  assert.deepEqual(JSON.parse(restoreCtx.widgets.get("plan-mode")[0]), { mode: "plan" });

  // Manual exit persists too.
  await commands.get("plan-exit").handler("", ctx);
  assert.equal(appended[appended.length - 1].data.mode, "execute");
});
