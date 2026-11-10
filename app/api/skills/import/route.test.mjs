import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-skill-import-"));
const agentDir = join(root, "agent");
const dataDir = join(root, "data");
const cwd = join(root, "project");
const previousEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_AUTH = "on";
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("../../../../lib/web-session.ts");
const { POST } = await jiti.import("./route.ts");
const JSZip = (await import("jszip")).default;
allowFileRoot(cwd);

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function zipFor(skillName) {
  const zip = new JSZip();
  zip.file(
    `${skillName}/SKILL.md`,
    ["---", `name: ${skillName}`, `description: ${skillName}`, "---", "", `# ${skillName}`, ""].join("\n"),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function upload(scope, skillName) {
  const session = createWebSession(
    { id: 1, username: "admin", email: null, role: "admin", status: "active" },
    "sk_test",
    1,
  );
  const body = new FormData();
  body.append("file", new File([await zipFor(skillName)], "skills.zip", { type: "application/zip" }));
  const response = await POST(
    new Request(
      `http://localhost/api/skills/import?cwd=${encodeURIComponent(cwd)}&scope=${scope}`,
      {
        method: "POST",
        headers: { host: "localhost", cookie: `${WEB_SESSION_COOKIE}=${session.sid}` },
        body,
      },
    ),
  );
  return { response, body: await response.json() };
}

test("upload writes to the selected global scope, not the project", async () => {
  const { response, body } = await upload("global", "global-upload");
  assert.equal(response.status, 200);
  assert.equal(body.scope, "global");
  assert.equal(existsSync(join(agentDir, "skills", "global-upload", "SKILL.md")), true);
  assert.equal(existsSync(join(cwd, ".pi", "skills", "global-upload")), false);
});

test("upload writes to the caller's user scope", async () => {
  const { response, body } = await upload("user", "user-upload");
  assert.equal(response.status, 200);
  assert.equal(body.scope, "user");
  assert.equal(existsSync(join(dataDir, "user-config", "u1", "skills", "user-upload", "SKILL.md")), true);
});

test("upload keeps the project default", async () => {
  const { response, body } = await upload("project", "project-upload");
  assert.equal(response.status, 200);
  assert.equal(body.scope, "project");
  assert.equal(existsSync(join(cwd, ".pi", "skills", "project-upload", "SKILL.md")), true);
});
