import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-skills-service-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DATA_DIR = dataDir;
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function installUserSkill(userId, name) {
  const dir = join(dataDir, "user-config", `u${userId}`, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} user skill`, "---", "", `# ${name}`, ""].join("\n"),
  );
}

async function installGlobalSkill(name) {
  const dir = join(agentDir, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} global skill`, "---", "", `# ${name}`, ""].join("\n"),
  );
}

test("labels the shared agent-dir store as global, not user", async () => {
  await installGlobalSkill("my-global-skill");

  const response = await loadSkillsWithInstallInfo(cwd, 7);
  const skill = response.skills.find((item) => item.name === "my-global-skill");

  assert.ok(skill, "global-scope skill is loaded");
  assert.equal(skill.sourceInfo.scope, "global");
});

test("loads the caller's user-scope skills from user-config/u<id>/skills", async () => {
  await installUserSkill(7, "my-user-skill");

  const response = await loadSkillsWithInstallInfo(cwd, 7);
  const skill = response.skills.find((item) => item.name === "my-user-skill");

  assert.ok(skill, "user-scope skill is loaded");
  assert.equal(skill.sourceInfo.scope, "user");
});

test("does not expose another user's skill", async () => {
  await installUserSkill(8, "other-user-skill");

  const response = await loadSkillsWithInstallInfo(cwd, 7);

  assert.equal(
    response.skills.some((item) => item.name === "other-user-skill"),
    false,
  );
});

test("without a user identity only project/global skills are loaded", async () => {
  await installUserSkill(7, "my-user-skill");

  const response = await loadSkillsWithInstallInfo(cwd, 0);

  assert.equal(
    response.skills.some((item) => item.name === "my-user-skill"),
    false,
  );
});
