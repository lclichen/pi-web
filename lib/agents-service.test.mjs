import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "agents-service-"));
const cwd = join(root, "project");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_WEB_DATA_DIR = join(root, "data");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listAgents, listAllAgents } = await jiti.import("./agents-service.ts");
const { userAgentsDir } = await jiti.import("./user-config.ts");

function agentFile(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n\nPrompt for ${name}.\n`);
}

agentFile(join(cwd, ".pi", "agents"), "project-agent", "project scoped");
agentFile(join(process.env.PI_CODING_AGENT_DIR, "agents"), "global-agent", "global scoped");
agentFile(userAgentsDir(7), "personal-agent", "user scoped");

test("auth-off (userId 0) lists project + global without entering the user scope", () => {
  const agents = listAllAgents(cwd, 0);
  const names = agents.map((agent) => agent.name);
  assert.ok(names.includes("project-agent"));
  assert.ok(names.includes("global-agent"));
  assert.ok(!names.includes("personal-agent"), "no user layer without a logged-in user");
  // Built-ins are appended by the project scope, so the page still renders.
  assert.ok(names.includes("general-purpose"));
});

test("a logged-in user gets the user layer merged in the documented order", () => {
  const agents = listAllAgents(cwd, 7);
  const scopes = agents.map((agent) => `${agent.scope}:${agent.name}`);
  assert.ok(scopes.includes("user:personal-agent"));
  const userIndex = scopes.indexOf("user:personal-agent");
  const projectIndex = scopes.indexOf("project:project-agent");
  const globalIndex = scopes.indexOf("global:global-agent");
  assert.ok(projectIndex < userIndex && userIndex < globalIndex);
});

test("an explicit user-scope list without a user still throws (route guards it)", () => {
  assert.throws(() => listAgents(cwd, "user", 0), /logged-in user/);
});
