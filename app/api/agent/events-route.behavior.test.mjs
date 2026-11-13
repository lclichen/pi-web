import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * /api/agent/[id]/events 真实 handler 行为测试：
 * aborted → 204；未知会话 → 404；已知合成会话 → SSE 200（text/event-stream）。
 * auth off（隐式 host admin）可直接按 session id 解析 host 空间。
 */
process.env.PI_WEB_AUTH = "";
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-events-agent-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-events-data-"));
process.env.PI_WEB_DATA_DIR = DATA_DIR;

const SESSION_ID = "qa-events-session";
const project = join(AGENT_DIR, "project");
mkdirSync(project, { recursive: true });
const sessionDir = join(AGENT_DIR, "sessions", "e2e");
mkdirSync(sessionDir, { recursive: true });
const timestamp = "2026-01-01T00:00:00.000Z";
writeFileSync(
  join(sessionDir, `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`),
  [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp, cwd: project }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }),
  ].join("\n") + "\n",
);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./[id]/events/route.ts");
const { getRpcSession } = await jiti.import("../../../lib/rpc-manager.ts");
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("@/lib/web-session.ts");

const HOST = "127.0.0.1:30141";

function req(path, { host = HOST, signal } = {}) {
  return new Request(`http://${host}${path}`, { headers: { host }, signal });
}

test("an aborted request short-circuits with 204", async () => {
  const controller = new AbortController();
  controller.abort();
  const res = await GET(req(`/api/agent/${SESSION_ID}/events`, { signal: controller.signal }), {
    params: Promise.resolve({ id: SESSION_ID }),
  });
  assert.equal(res.status, 204);
});

test("unknown session answers 404", async () => {
  const res = await GET(req("/api/agent/qa-events-missing/events"), {
    params: Promise.resolve({ id: "qa-events-missing" }),
  });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /not found/i);
});

test("known synthetic session opens an SSE stream", async () => {
  const res = await GET(req(`/api/agent/${SESSION_ID}/events`), {
    params: Promise.resolve({ id: SESSION_ID }),
  });
  try {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.ok(res.body, "SSE response must expose a readable body");
  } finally {
    await res.body?.cancel().catch(() => {});
  }
});

test("auth-on: session shard fences other users and serves the owner", async () => {
  const userId = 2;
  const sessionId = "qa-events-user2";
  const userDir = join(AGENT_DIR, "sessions", "users", `u${userId}`);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, `2026-01-02T00-00-00-000Z_${sessionId}.jsonl`),
    [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: project }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10),
  );

  const owner = createWebSession(
    { id: userId, username: "u2", email: null, role: "user", status: "active" },
    "sk_test",
    "",
  ).sid;
  const other = createWebSession(
    { id: 3, username: "u3", email: null, role: "user", status: "active" },
    "sk_test",
    "",
  ).sid;
  const previousAuth = process.env.PI_WEB_AUTH;
  process.env.PI_WEB_AUTH = "on";
  try {
    const call = (sid, id) =>
      GET(
        new Request(`http://${HOST}/api/agent/${id}/events`, {
          headers: { host: HOST, ...(sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {}) },
        }),
        { params: Promise.resolve({ id }) },
      );

    assert.equal((await call(null, sessionId)).status, 401);
    assert.equal((await call(other, sessionId)).status, 404);

    const own = await call(owner, sessionId);
    assert.equal(own.status, 200);
    assert.match(own.headers.get("content-type") ?? "", /text\/event-stream/);
    await own.body?.cancel().catch(() => {});
  } finally {
    process.env.PI_WEB_AUTH = previousAuth ?? "";
    await getRpcSession(sessionId)?.shutdown?.().catch?.(() => {});
  }
});

test.after(async () => {
  try {
    await getRpcSession(SESSION_ID)?.shutdown?.();
  } catch {
    /* best effort */
  }
  rmSync(AGENT_DIR, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});
