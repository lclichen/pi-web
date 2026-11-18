import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-sessions-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-embed-sessions-agent-"));
const sessionDir = join(agentDir, "sessions", "embed");
mkdirSync(sessionDir, { recursive: true });

process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_WEB_AUTH;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { createProject, projectHome } = await jiti.import("../../../lib/projects.ts");
const { recordSessionMeta, flushSessionMetasForTests } = await jiti.import("../../../lib/session-metas.ts");
const { createEmbedAccessToken } = await jiti.import("../../../lib/embed-access.ts");

const created = await createProject({
  name: "Embed Scope Project",
  ownerId: 0,
  ownerName: "host",
  mode: "sandbox",
  embed: { productId: "default", clientId: "c1", externalRef: "default", createdAt: Date.now() },
});
assert.equal(created.ok, true);
if (!created.ok) throw new Error(created.error);
const project = created.project;
const home = projectHome(project);

function writeSession(id, cwd) {
  const header = { type: "session", version: 3, id, timestamp: "2026-11-17T00:00:00.000Z", cwd };
  const message = {
    type: "message",
    id: `${id}-m1`,
    parentId: null,
    timestamp: "2026-11-17T00:00:01.000Z",
    message: { role: "user", content: `hello ${id}` },
  };
  writeFileSync(join(sessionDir, `${id}.jsonl`), [header, message].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
writeSession("session-a", home);
writeSession("session-b", home);
recordSessionMeta("session-a", { mode: "sandbox", ownerId: 0, projectId: project.id });
recordSessionMeta("session-b", { mode: "sandbox", ownerId: 0, projectId: "other-project" });
flushSessionMetasForTests();

const { token } = createEmbedAccessToken({
  user: { id: 0, username: "host", email: null, role: "admin", status: "active" },
  apiKey: "",
  productId: "default",
  scope: { kind: "project", projectId: project.id, cwd: home },
  allowedRoots: [home],
  mode: "sandbox",
  label: project.name,
  ttlMs: 60_000,
});

const HOST = "127.0.0.1:30141";
function request(path) {
  return new Request(`http://${HOST}${path}`, {
    headers: { host: HOST, Authorization: `Bearer ${token}` },
  });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

test("lists only sessions in the access token's project and fences single-session reads", async () => {
  const list = await GET(request("/api/sessions"));
  assert.equal(list.status, 200, await list.clone().text());
  const data = await list.json();
  assert.deepEqual(
    data.sessions.map((session) => session.id),
    ["session-a"],
  );

  const sessionRoute = await jiti.import("./[id]/route.ts");
  const own = await sessionRoute.GET(request("/api/sessions/session-a"), {
    params: Promise.resolve({ id: "session-a" }),
  });
  assert.equal(own.status, 200);

  const other = await sessionRoute.GET(request("/api/sessions/session-b"), {
    params: Promise.resolve({ id: "session-b" }),
  });
  assert.equal(other.status, 404);

  const rename = await sessionRoute.PATCH(
    new Request(`http://${HOST}/api/sessions/session-a`, {
      method: "PATCH",
      headers: { host: HOST, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    }),
    { params: Promise.resolve({ id: "session-a" }) },
  );
  assert.equal(rename.status, 200);
  const afterArchive = await (await GET(request("/api/sessions"))).json();
  assert.deepEqual(afterArchive.sessions, []);
  const withArchive = await (await GET(request("/api/sessions?includeArchived=1"))).json();
  assert.deepEqual(
    withArchive.sessions.map((session) => session.id),
    ["session-a"],
  );
});
