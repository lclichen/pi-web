import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Extension-level integration for the server-side skill read bridge: the
 * relay read/ls tools must serve skills-shaped paths from the SERVER (project
 * home / pinned .pi/agent/skills) and never reach the relay transport —
 * skill files do not exist on the user's machine by design.
 */

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadTools(options) {
  const { makeRelayToolsExtension } = await jiti.import("../extensions/relay-tools.ts");
  const tools = new Map();
  makeRelayToolsExtension(1, options).factory({
    registerTool: (t) => tools.set(t.name, t),
    on: () => {},
  });
  return tools;
}

function projectHomeWith(fixture = (dir) => {}) {
  const home = mkdtempSync(join(tmpdir(), "relay-skill-"));
  fixture(home);
  return home;
}

const call = (tool, params, cwd) => tool.execute("t1", params, undefined, undefined, cwd ? { cwd } : undefined);

test("read serves project-scope skill paths from the server home", async () => {
  const home = projectHomeWith((dir) => {
    mkdirSync(join(dir, ".pi", "skills", "demo"), { recursive: true });
    writeFileSync(join(dir, ".pi/skills/demo/SKILL.md"), "name: demo\nbody-from-server-home\n", "utf8");
  });
  const tools = await loadTools({ projectHome: home });
  const r = await call(tools.get("read"), { path: "~/.pi/skills/demo/SKILL.md" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /body-from-server-home/);
  // The prompt-relative form works even without projectHome — ctx.cwd is the
  // fallback home (non-project sessions).
  const r2 = await call(tools.get("read"), { path: ".pi/skills/demo/SKILL.md" }, home);
  assert.match(r2.content[0].text, /body-from-server-home/);
});

test("read serves user-scope skill paths from the project home pin first", async () => {
  const home = projectHomeWith((dir) => {
    mkdirSync(join(dir, ".pi", "agent", "skills", "pinned"), { recursive: true });
    writeFileSync(join(dir, ".pi/agent/skills/pinned/SKILL.md"), "pinned-user-scope\n", "utf8");
  });
  const tools = await loadTools({ projectHome: home });
  // The incident path: model-expanded ~ against ITS machine's home.
  const r = await call(tools.get("read"), { path: "/infra_home/ai0944/.pi/agent/skills/pinned/SKILL.md" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /pinned-user-scope/);
});

test("ls bridges skill directories instead of relaying", async () => {
  const home = projectHomeWith((dir) => {
    mkdirSync(join(dir, ".pi", "skills", "alpha"), { recursive: true });
    mkdirSync(join(dir, ".pi", "skills", "beta"), { recursive: true });
  });
  const tools = await loadTools({ projectHome: home });
  const r = await call(tools.get("ls"), { path: "~/.pi/skills" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /d alpha/);
  assert.match(r.content[0].text, /d beta/);
});
