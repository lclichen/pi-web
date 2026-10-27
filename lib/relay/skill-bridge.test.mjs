import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Server-side skill read bridge (lib/relay/skill-bridge.ts): runtime skill
 * files live on the pi-web server — session homes' .pi/skills (project
 * scope) and the server agent dir's skills/ (user scope). Any skills-shaped
 * path the model produces must map to a server location, whatever prefix it
 * carries; anything else must stay null so it relays normally.
 */

async function api() {
  return jiti.import("./skill-bridge.ts");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-bridge-"));
  const projectHome = join(root, "proj");
  const agentDir = join(root, "agentdir");
  mkdirSync(join(projectHome, ".pi", "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(projectHome, ".pi", "skills", "demo-skill", "SKILL.md"), "project skill", "utf8");
  mkdirSync(join(agentDir, "skills", "self-introduce"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "self-introduce", "SKILL.md"), "user skill", "utf8");
  return { root, projectHome, agentDir };
}

const OPTS = (f) => ({ homes: [f.projectHome], agentDir: f.agentDir });

test("project-scope shapes map to the session home", async () => {
  const { matchServerSkillPath } = await api();
  const f = fixture();
  const o = OPTS(f);
  // Relative form (the classic bridge case).
  assert.equal(matchServerSkillPath(".pi/skills/demo-skill/SKILL.md", o)?.path, join(f.projectHome, ".pi/skills/demo-skill/SKILL.md"));
  // Absolute under the project home.
  assert.equal(
    matchServerSkillPath(join(f.projectHome, ".pi/skills/demo-skill/SKILL.md"), o)?.path,
    join(f.projectHome, ".pi/skills/demo-skill/SKILL.md"),
  );
  // The marker directory itself (ls).
  assert.equal(matchServerSkillPath(".pi/skills", o)?.path, join(f.projectHome, ".pi/skills"));
});

test("user-scope shapes map to the server agent dir regardless of prefix", async () => {
  const { matchServerSkillPath } = await api();
  const f = fixture();
  const o = OPTS(f);
  const expected = join(f.agentDir, "skills/self-introduce/SKILL.md");
  // Exactly as the system prompt lists it.
  assert.equal(matchServerSkillPath("~/.pi/agent/skills/self-introduce/SKILL.md", o)?.path, expected);
  // Model-expanded ~ against the CLIENT machine's home (the incident path).
  assert.equal(matchServerSkillPath("/infra_home/ai0944/.pi/agent/skills/self-introduce/SKILL.md", o)?.path, expected);
  // Tilde-with-username and directory form.
  assert.equal(matchServerSkillPath("~user/.pi/agent/skills/self-introduce/SKILL.md", o)?.path, expected);
  assert.equal(matchServerSkillPath("~/.pi/agent/skills", o)?.path, join(f.agentDir, "skills"));
});

test("project home wins over the agent dir when both carry the file", async () => {
  const { matchServerSkillPath } = await api();
  const f = fixture();
  mkdirSync(join(f.projectHome, ".pi", "agent", "skills", "pinned"), { recursive: true });
  writeFileSync(join(f.projectHome, ".pi/agent/skills/pinned/SKILL.md"), "pinned", "utf8");
  const m = matchServerSkillPath("~/.pi/agent/skills/pinned/SKILL.md", OPTS(f));
  assert.equal(m?.path, join(f.projectHome, ".pi/agent/skills/pinned/SKILL.md"));
});

test("missing candidates resolve to the first root (server-side failure, never relayed)", async () => {
  const { matchServerSkillPath } = await api();
  const f = fixture();
  assert.equal(
    matchServerSkillPath("~/.pi/agent/skills/nope/SKILL.md", OPTS(f))?.path,
    join(f.agentDir, "skills/nope/SKILL.md"),
  );
});

test("non-skill paths and traversal attempts are not bridged", async () => {
  const { matchServerSkillPath } = await api();
  const f = fixture();
  const o = OPTS(f);
  for (const p of ["", ".", "poem.txt", "src/main.ts", "/etc/passwd", "~/notes/todo.md", "@README.md"]) {
    assert.equal(matchServerSkillPath(p, o), null, p);
  }
  // A workspace file that merely sits next to the marker tree stays local.
  assert.equal(matchServerSkillPath(".pi/skills-mirror/SKILL.md", o), null);
  // No homes configured → only the user-scope tree is bridged.
  assert.equal(matchServerSkillPath(".pi/skills/demo-skill/SKILL.md", { agentDir: f.agentDir }), null);
  assert.equal(
    matchServerSkillPath("~/.pi/agent/skills/self-introduce/SKILL.md", { agentDir: f.agentDir })?.path,
    join(f.agentDir, "skills/self-introduce/SKILL.md"),
  );
  // .. escapes are rejected (no bridging into arbitrary server paths).
  assert.equal(matchServerSkillPath("~/.pi/agent/skills/../auth.json", { agentDir: f.agentDir }), null);
});
