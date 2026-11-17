import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-sessions-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-embed-sessions-agent-"));
const cwdA = join(agentDir, "workspace-a");
const cwdB = join(agentDir, "workspace-b");
mkdirSync(cwdA, { recursive: true });
mkdirSync(cwdB, { recursive: true });
const sessionDir = join(agentDir, "sessions", "embed");
mkdirSync(sessionDir, { recursive: true });

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
writeSession("session-a", cwdA);
writeSession("session-b", cwdB);

process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_WEB_AUTH;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { createEmbedToken } = await jiti.import("../../../lib/embed-tokens.ts");

const { token } = createEmbedToken({
  owner: { id: 0, username: "host", email: null, role: "admin", status: "active" },
  productId: "default",
  scope: { kind: "host", cwd: cwdA },
  allowedRoots: [cwdA],
  mode: "host",
  label: "A",
  apiKey: "",
  apiKeyId: "",
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

test("lists only sessions in the token's workspace and fences single-session reads", async () => {
  const list = await GET(request("/api/sessions"));
  assert.equal(list.status, 200, await list.clone().text());
  const data = await list.json();
  assert.deepEqual(
    data.sessions.map((session) => session.id),
    ["session-a"],
  );

  const own = await (await jiti.import("./[id]/route.ts")).GET(request("/api/sessions/session-a"), {
    params: Promise.resolve({ id: "session-a" }),
  });
  assert.equal(own.status, 200);

  const other = await (await jiti.import("./[id]/route.ts")).GET(request("/api/sessions/session-b"), {
    params: Promise.resolve({ id: "session-b" }),
  });
  assert.equal(other.status, 404);
});
