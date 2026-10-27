import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Server-side runtime-config read bridge (lib/relay/runtime-config-bridge.ts):
 * skills and subagent definitions live on the pi-web server — session homes'
 * .pi/skills|.pi/agents (project scope) and the server agent dir's skills/|
 * agents/ (user scope). Any config-shaped path the model produces must map to
 * a server location, whatever prefix it carries; anything else must stay null
 * so it relays normally.
 */

async function api() {
  return jiti.import("./runtime-config-bridge.ts");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "config-bridge-"));
  const projectHome = join(root, "proj");
  const agentDir = join(root, "agentdir");
  mkdirSync(join(projectHome, ".pi", "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(projectHome, ".pi/skills/demo-skill/SKILL.md"), "project skill", "utf8");
  mkdirSync(join(agentDir, "skills", "self-introduce"), { recursive: true });
  writeFileSync(join(agentDir, "skills/self-introduce/SKILL.md"), "user skill", "utf8");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents/researcher.md"), "user agent def", "utf8");
  return { root, projectHome, agentDir };
}

const OPTS = (f) => ({ homes: [f.projectHome], agentDir: f.agentDir });

test("project-scope shapes map to the session home (skills + subagents)", async () => {
  const { matchRuntimeConfigPath } = await api();
  const f = fixture();
  const o = OPTS(f);
  // Relative form (the classic bridge case).
  assert.equal(matchRuntimeConfigPath(".pi/skills/demo-skill/SKILL.md", o)?.path, join(f.projectHome, ".pi/skills/demo-skill/SKILL.md"));
  // Absolute under the project home.
  assert.equal(
    matchRuntimeConfigPath(join(f.projectHome, ".pi/skills/demo-skill/SKILL.md"), o)?.path,
    join(f.projectHome, ".pi/skills/demo-skill/SKILL.md"),
  );
  // The marker directory itself (ls) — both config trees.
  assert.equal(matchRuntimeConfigPath(".pi/skills", o)?.path, join(f.projectHome, ".pi/skills"));
  assert.equal(matchRuntimeConfigPath(".pi/agents", o)?.path, join(f.projectHome, ".pi/agents"));
});

test("user-scope shapes map to the server agent dir regardless of prefix", async () => {
  const { matchRuntimeConfigPath } = await api();
  const f = fixture();
  const o = OPTS(f);
  // Exactly as the system prompt lists it.
  assert.equal(matchRuntimeConfigPath("~/.pi/agent/skills/self-introduce/SKILL.md", o)?.path, join(f.agentDir, "skills/self-introduce/SKILL.md"));
  // Model-expanded ~ against the CLIENT machine's home (the incident path).
  assert.equal(matchRuntimeConfigPath("/infra_home/ai0944/.pi/agent/skills/self-introduce/SKILL.md", o)?.path, join(f.agentDir, "skills/self-introduce/SKILL.md"));
  // Tilde-with-username and directory form.
  assert.equal(matchRuntimeConfigPath("~user/.pi/agent/skills/self-introduce/SKILL.md", o)?.path, join(f.agentDir, "skills/self-introduce/SKILL.md"));
  assert.equal(matchRuntimeConfigPath("~/.pi/agent/skills", o)?.path, join(f.agentDir, "skills"));
  // Subagent definitions: user scope via ~/.pi/agent/agents.
  assert.equal(matchRuntimeConfigPath("~/.pi/agent/agents/researcher.md", o)?.path, join(f.agentDir, "agents/researcher.md"));
  assert.equal(matchRuntimeConfigPath("/home/whoever/.pi/agent/agents/researcher.md", o)?.path, join(f.agentDir, "agents/researcher.md"));
});

test("project home wins over the agent dir when both carry the file", async () => {
  const { matchRuntimeConfigPath } = await api();
  const f = fixture();
  mkdirSync(join(f.projectHome, ".pi", "agent", "skills", "pinned"), { recursive: true });
  writeFileSync(join(f.projectHome, ".pi/agent/skills/pinned/SKILL.md"), "pinned", "utf8");
  const m = matchRuntimeConfigPath("~/.pi/agent/skills/pinned/SKILL.md", OPTS(f));
  assert.equal(m?.path, join(f.projectHome, ".pi/agent/skills/pinned/SKILL.md"));
});

test("missing candidates resolve to the canonical root (server-side failure, never relayed)", async () => {
  const { matchRuntimeConfigPath } = await api();
  const f = fixture();
  assert.equal(
    matchRuntimeConfigPath("~/.pi/agent/skills/nope/SKILL.md", OPTS(f))?.path,
    join(f.agentDir, "skills/nope/SKILL.md"),
  );
  assert.equal(
    matchRuntimeConfigPath("~/.pi/agent/agents/ghost.md", OPTS(f))?.path,
    join(f.agentDir, "agents/ghost.md"),
  );
});

test("non-config paths and traversal attempts are not bridged", async () => {
  const { matchRuntimeConfigPath } = await api();
  const f = fixture();
  const o = OPTS(f);
  for (const p of ["", ".", "poem.txt", "src/main.ts", "/etc/passwd", "~/notes/todo.md", "@README.md"]) {
    assert.equal(matchRuntimeConfigPath(p, o), null, p);
  }
  // A workspace file that merely sits next to the config tree stays local.
  assert.equal(matchRuntimeConfigPath(".pi/skills-mirror/SKILL.md", o), null);
  assert.equal(matchRuntimeConfigPath(".pi/agents-notes/x.md", o), null);
  // No homes configured → only the user-scope tree is bridged.
  assert.equal(matchRuntimeConfigPath(".pi/skills/demo-skill/SKILL.md", { agentDir: f.agentDir }), null);
  assert.equal(matchRuntimeConfigPath(".pi/agents/researcher.md", { agentDir: f.agentDir }), null);
  assert.equal(
    matchRuntimeConfigPath("~/.pi/agent/skills/self-introduce/SKILL.md", { agentDir: f.agentDir })?.path,
    join(f.agentDir, "skills/self-introduce/SKILL.md"),
  );
  // .. escapes are rejected (no bridging into arbitrary server paths).
  assert.equal(matchRuntimeConfigPath("~/.pi/agent/skills/../auth.json", { agentDir: f.agentDir }), null);
  assert.equal(matchRuntimeConfigPath(".pi/agents/../../etc/passwd", o), null);
});
