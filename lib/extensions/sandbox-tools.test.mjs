import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * amedac-core sandbox module (merged from the retired pi-sandbox-extension):
 * the runtime-config bridge must map skills/subagent-definition paths to the
 * HOST side whatever prefix the model used — the container never carries
 * them (.pi is in the sync ignore list), including the user-scope trees
 * (~/.pi/agent/skills|agents) the old package's narrow .pi/skills-only
 * bridge missed.
 */

async function api() {
  return jiti.import("../../pi-config/agent/extensions/amedac-core/src/sandbox/config-bridge.ts");
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sbx-bridge-"));
  const home = join(root, "proj");
  const agentDir = join(root, "agentdir");
  mkdirSync(join(home, ".pi", "skills", "demo"), { recursive: true });
  writeFileSync(join(home, ".pi/skills/demo/SKILL.md"), "project skill", "utf8");
  mkdirSync(join(agentDir, "skills", "self-introduce"), { recursive: true });
  writeFileSync(join(agentDir, "skills/self-introduce/SKILL.md"), "user skill", "utf8");
  return { root, home, agentDir };
}

test("project-scope shapes bridge to the session home", async () => {
  const { matchRuntimeConfigFile } = await api();
  const f = await fixture();
  const m = (p) => matchRuntimeConfigFile(p, [f.home], f.agentDir);
  assert.equal(m(".pi/skills/demo/SKILL.md"), join(f.home, ".pi/skills/demo/SKILL.md"));
  // Container-absolute shape (model echoing the guest /workspace prefix).
  assert.equal(m("/workspace/.pi/skills/demo/SKILL.md"), join(f.home, ".pi/skills/demo/SKILL.md"));
  assert.equal(m(".pi/agents"), join(f.home, ".pi/agents"));
});

test("user-scope shapes bridge to the agent dir whatever home the model expanded", async () => {
  const { matchRuntimeConfigFile } = await api();
  const f = await fixture();
  const m = (p) => matchRuntimeConfigFile(p, [f.home], f.agentDir);
  const expected = join(f.agentDir, "skills/self-introduce/SKILL.md");
  // As listed in the system prompt (host home ~)…
  assert.equal(m("~/.pi/agent/skills/self-introduce/SKILL.md"), expected);
  // …and as expanded against the CONTAINER root (the gap this merge fixes).
  assert.equal(m("/root/.pi/agent/skills/self-introduce/SKILL.md"), expected);
  assert.equal(m("~/.pi/agent/agents/planner.md"), join(f.agentDir, "agents/planner.md"));
});

test("non-config paths and traversal attempts pass through (null)", async () => {
  const { matchRuntimeConfigFile } = await api();
  const f = await fixture();
  const m = (p) => matchRuntimeConfigFile(p, [f.home], f.agentDir);
  for (const p of [
    "",
    ".",
    "src/main.ts",
    "/workspace/src/main.ts",
    "/etc/hostname",
    "~/notes.md",
    "/workspace/.pi/sessions/x.json",
  ]) {
    assert.equal(m(p), null, p);
  }
  assert.equal(m("~/.pi/agent/skills/../auth.json"), null);
});

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("pi-web injects the amedac-core sandbox factory at every session entry point", async () => {
  const created = await read("../../app/api/agent/new/route.ts");
  assert.match(created, /makeSandboxToolsExtension\(\),/);
  assert.ok(!created.includes("PI_WEB_SANDBOX_EXTENSION_PATH"), "agent/new must not read the retired env var");

  const restored = await read("../session-restore-options.ts");
  assert.match(restored, /makeSandboxToolsExtension\(\),/);

  const bridge = await read("../subagent-bridge.ts");
  assert.match(bridge, /case "sandbox": \{[\s\S]*?makeSandboxToolsExtension\(\),/);

  const runner = await read("../batch/task-runner.ts");
  assert.match(runner, /makeSandboxToolsExtension\(\),/);
  assert.ok(!runner.includes("PI_WEB_SANDBOX_EXTENSION_PATH"), "task-runner must not read the retired env var");
});

test("legacy project-home extension links are removed, not created", async () => {
  const projects = await read("../projects.ts");
  assert.match(projects, /export function removeLegacySandboxExtensionLink/);
  assert.ok(!projects.includes("ensureSandboxExtensionLink"), "the link-creating helper must be gone");
});

test("amedac-core default registration gates the sandbox tools on config presence", async () => {
  const mod = await jiti.import("../../pi-config/agent/extensions/amedac-core/index.ts");
  const makePi = () => {
    const tools = new Map();
    const commands = new Map();
    const handlers = new Map();
    return {
      registerTool: (t) => tools.set(t.name, t),
      registerCommand: (name, def) => commands.set(name, def),
      registerFlag: () => {},
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      tools,
      commands,
      handlers,
    };
  };

  // No sandbox config in this process (env scrubbed, cwd has no .pi config):
  // the default export must still register every core module (incl. the
  // previously-missed path-guard) but NOT the container tools.
  const prevUrl = process.env.SANDBOX_PLATFORM_URL;
  const prevContainer = process.env.SANDBOX_CONTAINER;
  delete process.env.SANDBOX_PLATFORM_URL;
  delete process.env.SANDBOX_CONTAINER;
  const plain = makePi();
  mod.default(plain);
  assert.ok(plain.tools.size > 0, "core modules register tools");
  assert.equal(plain.commands.has("sandbox-login"), false, "sandbox commands stay gated off");
  // With the env gate on, the sandbox module registers: container tool names
  // collide with built-ins by design (last registration wins) — assert via a
  // sandbox-only command instead.
  process.env.SANDBOX_PLATFORM_URL = "http://sandbox.example";
  try {
    const gated = makePi();
    mod.default(gated);
    assert.ok(gated.commands.has("sandbox-login"), "env gate registers the sandbox module");
    assert.ok(gated.commands.has("todo-clear"), "core modules still register alongside");
  } finally {
    if (prevUrl === undefined) delete process.env.SANDBOX_PLATFORM_URL;
    else process.env.SANDBOX_PLATFORM_URL = prevUrl;
    if (prevContainer !== undefined) process.env.SANDBOX_CONTAINER = prevContainer;
  }
});
