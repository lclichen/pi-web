import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-skills-route-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_AUTH = "on";
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("../../../lib/web-session.ts");
allowFileRoot(cwd);
const { DELETE, PATCH } = await jiti.import("./route.ts");

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function sessionCookie(user) {
  const session = createWebSession(user, "sk_test", 1);
  return `${WEB_SESSION_COOKIE}=${session.sid}`;
}

async function createUserSkill(userId, name) {
  const dir = join(dataDir, "user-config", `u${userId}`, "skills", name);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  await writeFile(
    filePath,
    ["---", `name: ${name}`, `description: ${name} test skill`, "---", "", `# ${name}`, ""].join("\n"),
  );
  return { dir, filePath };
}

const user7 = { id: 7, username: "user7", email: null, role: "user", status: "active" };
const user8 = { id: 8, username: "user8", email: null, role: "user", status: "active" };

test("PATCH accepts a skill installed in the caller's own user scope", async () => {
  const { filePath } = await createUserSkill(7, "toggle-me");
  const response = await PATCH(
    new Request("http://localhost/api/skills", {
      method: "PATCH",
      headers: {
        host: "localhost",
        cookie: sessionCookie(user7),
        "content-type": "application/json",
      },
      body: JSON.stringify({ filePath, disableModelInvocation: true }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  const content = await readFile(filePath, "utf8");
  assert.match(content, /disable-model-invocation: true/);
});

test("PATCH rejects another user's user-scope skill", async () => {
  const { filePath } = await createUserSkill(8, "not-yours");
  const response = await PATCH(
    new Request("http://localhost/api/skills", {
      method: "PATCH",
      headers: {
        host: "localhost",
        cookie: sessionCookie(user7),
        "content-type": "application/json",
      },
      body: JSON.stringify({ filePath, disableModelInvocation: true }),
    }),
  );

  assert.equal(response.status, 403);
});

test("DELETE removes a directory-based skill from the caller's user scope", async () => {
  const { dir, filePath } = await createUserSkill(7, "delete-me");
  const response = await DELETE(
    new Request(`http://localhost/api/skills?filePath=${encodeURIComponent(filePath)}`, {
      method: "DELETE",
      headers: { host: "localhost", cookie: sessionCookie(user7) },
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(existsSync(dir), false);
});

test("DELETE removes a flat .md skill and keeps its siblings", async () => {
  const skillsDir = join(dataDir, "user-config", "u7", "skills");
  const flat = join(skillsDir, "flat-skill.md");
  const sibling = join(skillsDir, "keep.md");
  await mkdir(skillsDir, { recursive: true });
  await writeFile(flat, "---\nname: flat-skill\ndescription: flat\n---\n");
  await writeFile(sibling, "---\nname: keep\ndescription: keep\n---\n");

  const response = await DELETE(
    new Request(`http://localhost/api/skills?filePath=${encodeURIComponent(flat)}`, {
      method: "DELETE",
      headers: { host: "localhost", cookie: sessionCookie(user7) },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(existsSync(flat), false);
  assert.equal(existsSync(sibling), true);
});

test("DELETE refuses to remove the skill root itself", async () => {
  const skillsDir = join(dataDir, "user-config", "u7", "skills");
  const rootSkillFile = join(skillsDir, "SKILL.md");
  await mkdir(skillsDir, { recursive: true });
  await writeFile(rootSkillFile, "---\nname: root\ndescription: root\n---\n");
  const response = await DELETE(
    new Request(`http://localhost/api/skills?filePath=${encodeURIComponent(rootSkillFile)}`, {
      method: "DELETE",
      headers: { host: "localhost", cookie: sessionCookie(user7) },
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(existsSync(skillsDir), true);
});
