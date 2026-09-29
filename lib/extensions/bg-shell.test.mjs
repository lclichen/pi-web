import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** bg-shell extension contract: registry, tools, channel routing, stop bridge. */

const resetRegistry = () => {
  globalThis.__amedacBgShell = undefined;
};

async function loadExtension() {
  const mod = await import("./bg-shell.ts");
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const widgets = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, def) => commands.set(name, def),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: () => {},
  };
  mod.makeBgShellExtension()(pi);
  return { mod, pi, tools, commands, handlers, widgets };
}

function makeCtx({ sessionId = "sess-bg-1", cwd, channel } = {}) {
  // The registry is created lazily inside the extension — materialize it
  // BEFORE registering the channel mock (an optional-chain set on an absent
  // registry silently no-ops and the extension falls back to local spawn).
  globalThis.__amedacBgShell ??= { tasks: new Map(), channels: new Map(), timers: new Map(), children: new Map() };
  if (channel) globalThis.__amedacBgShell.channels.set(sessionId, channel);
  const widgets = new Map();
  const ctx = {
    cwd,
    mode: "rpc",
    ui: { setWidget: (key, lines) => widgets.set(key, lines) },
    sessionManager: { getSessionId: () => sessionId },
  };
  return { ctx, widgets };
}

const call = (tool, params, ctx) => tool.execute("t1", params, undefined, undefined, ctx);

test.afterEach(() => resetRegistry());

test("registers bg_run / bg_list / bg_stop with prompt guidance", async () => {
  const { tools } = await loadExtension();
  assert.ok(tools.has("bg_run") && tools.has("bg_list") && tools.has("bg_stop"));
  const run = tools.get("bg_run");
  assert.ok(run.promptGuidelines.length >= 2, "usage timing must be taught");
  assert.match(run.promptGuidelines.join("\n"), /read the output file/i);
});

test("local executor: bg_run spawns detached, list reports, stop kills", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-local-"));
  try {
    const { tools, handlers } = await loadExtension();
    const sessionStart = handlers.get("session_start")[0];
    const { ctx } = makeCtx({ sessionId: "s-local", cwd: dir });
    await sessionStart({}, ctx);

    const started = await call(tools.get("bg_run"), { command: "node -e \"setTimeout(()=>{}, 2000)\"", name: "sleeper" }, ctx);
    assert.equal(started.isError, undefined);
    assert.match(started.details.taskId, /^bg-/);
    assert.ok(Number(started.details.pid) > 0);
    assert.match(started.content[0].text, /\.pi\/tmp\/bg\/bg-.+\.log/);

    const listed = await call(tools.get("bg_list"), {}, ctx);
    assert.match(listed.content[0].text, /1 running/);
    assert.match(listed.content[0].text, /sleeper/);

    const stopped = await call(tools.get("bg_stop"), { taskId: started.details.taskId }, ctx);
    assert.equal(stopped.isError, undefined);
    const after = await call(tools.get("bg_list"), {}, ctx);
    assert.match(after.content[0].text, /cancelled/);
  } finally {
    // Windows handle-release timing after taskkill is jittery in the test
    // env (verified clean in isolation) — cleanup is best-effort and must
    // not fail the contract assertions.
    await new Promise((r) => setTimeout(r, 1200));
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    } catch {
      console.warn("(temp dir left behind: Windows handle release lag)");
    }
  }
});

test("remote channel: nohup pattern over run(), pid from echo", async () => {
  resetRegistry();
  const { tools, handlers, mod } = await loadExtension();
  const calls = [];
  const channel = {
    label: "ssh",
    kind: "remote",
    run: async (command) => {
      calls.push(command);
      if (command.startsWith("nohup")) return { stdout: "\n4242\n", stderr: "", exitCode: 0 };
      if (command.includes("kill -0")) return { stdout: "ALIVE\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const sessionStart = handlers.get("session_start")[0];
  const { ctx } = makeCtx({ sessionId: "s-ssh", cwd: "/tmp/x", channel });
  await sessionStart({}, ctx);

  const started = await call(tools.get("bg_run"), { command: "npm run dev", name: "web" }, ctx);
  assert.equal(started.isError, undefined);
  assert.equal(started.details.pid, "4242");
  // script written via base64, then nohup with log redirect + echo $!
  const scriptCall = calls.find((c) => c.includes("base64 -d"));
  assert.ok(scriptCall, "command lands via base64-encoded script");
  const nohupCall = calls.find((c) => c.startsWith("nohup"));
  assert.ok(nohupCall.includes("2>&1 < /dev/null & echo $!"), "detached with output redirect");

  const stopped = await call(tools.get("bg_stop"), { taskId: started.details.taskId }, ctx);
  assert.equal(stopped.isError, undefined);
  assert.ok(calls.some((c) => c.includes("kill") && c.includes("4242")), "stop kills by pid");
  assert.ok(mod.listBgTasks("s-ssh").every((t) => t.status !== "running"));
});

test("stop bridge + lost marking + task cap", async () => {
  resetRegistry();
  const { tools, handlers, mod } = await loadExtension();
  const sessionStart = handlers.get("session_start")[0];
  const channel = {
    label: "ssh",
    kind: "remote",
    run: async (command) => {
      if (command.startsWith("nohup")) return { stdout: "111\n", stderr: "", exitCode: 0 };
      if (command.includes("kill -0")) return { stdout: "GONE\n", stderr: "", exitCode: 0 };
      if (command.includes("kill --")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const { ctx } = makeCtx({ sessionId: "s-cap", cwd: "/tmp/x", channel });
  await sessionStart({}, ctx);

  for (let i = 0; i < 5; i++) {
    const r = await call(tools.get("bg_run"), { command: `job-${i}` }, ctx);
    assert.equal(r.isError, undefined, `task ${i} starts`);
  }
  const sixth = await call(tools.get("bg_run"), { command: "job-5" }, ctx);
  assert.equal(sixth.isError, true);
  assert.match(sixth.content[0].text, /max 5/);

  // stop bridge（wrapper stop_bg 同路径）
  const taskId = mod.listBgTasks("s-cap")[0].taskId;
  const via = await mod.stopBgTask("s-cap", taskId);
  assert.deepEqual(via, { ok: true });
  const missing = await mod.stopBgTask("s-cap", "bg-nope");
  assert.equal(missing.ok, false);

  // restart semantics: session_start again marks non-child running tasks lost
  await new Promise((r) => setTimeout(r, 30));
  await sessionStart({}, ctx);
  const stillRunning = mod.listBgTasks("s-cap").filter((t) => t.status === "running");
  assert.equal(stillRunning.length, 0, "no task survives a restart as running (children absent → lost/cancelled)");
});

test("wiring: remote channels registered per mode (source contract)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const restore = rf(new URL("../session-restore-options.ts", import.meta.url), "utf8");
  assert.ok(restore.includes("makeSshBgChannel"), "ssh mode registers a bg channel");
  assert.ok(restore.includes("makeSandboxBgChannel"), "sandbox mode registers a bg channel");
  assert.ok(restore.includes("makeRelayBgChannel"), "local-machine mode registers a bg channel");
  assert.ok(restore.includes("容器尚未创建"), "pre-project sandbox gets a rejecting stub (never falls back to local spawn)");
  const rpc = rf(new URL("../rpc-manager.ts", import.meta.url), "utf8");
  assert.ok(rpc.includes('"stop_bg"'), "wrapper stop_bg command exists");
  const chat = rf(new URL("../../components/ChatStatusWidget.tsx", import.meta.url), "utf8");
  assert.ok(chat.includes("chat.status.bgTasks"), "capsule 任务 section renders");
});
