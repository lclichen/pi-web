import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * requireAdminIdentity: the admin gate for platform-management BFF routes.
 * Behavioral test against the real session store (temp data dir), mirroring
 * web-session.test.mjs's store surgery for role switching.
 */

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-adminauth-test-"));
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_AUTH = "on";

const adminUser = { id: 1, username: "root", email: null, role: "admin", status: "active" };
const plainUser = { id: 2, username: "alice", email: null, role: "user", status: "active" };

async function loadSubject() {
  return import("./web-session.ts");
}

function requestWith(sid) {
  return new Request("http://x/api", { headers: { cookie: `pi_web_sid=${sid}` } });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("admins pass, plain users get 403, missing sessions get 401", async () => {
  const mod = await loadSubject();
  const admin = mod.createWebSession(adminUser, "sk_a", 1);
  const plain = mod.createWebSession(plainUser, "sk_b", 2);

  const ok = mod.requireAdminIdentity(requestWith(admin.sid));
  assert.ok(ok.ok && ok.session.user.role === "admin");

  const forbidden = mod.requireAdminIdentity(requestWith(plain.sid));
  assert.deepEqual(forbidden, { ok: false, status: 403 });

  const anonymous = mod.requireAdminIdentity(new Request("http://x/api"));
  assert.deepEqual(anonymous, { ok: false, status: 401 });
});

test("change-ticket sessions never qualify even for admins", async () => {
  const mod = await loadSubject();
  const ticket = mod.createWebSession(adminUser, "", "", "ticket-1");
  const result = mod.requireAdminIdentity(requestWith(ticket.sid));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("auth disabled ⇒ implicit host admin passes", async () => {
  const mod = await loadSubject();
  const prev = process.env.PI_WEB_AUTH;
  process.env.PI_WEB_AUTH = "off";
  try {
    const identity = mod.requireAdminIdentity(new Request("http://x/api"));
    assert.ok(identity.ok && identity.session.user.username === "host");
  } finally {
    process.env.PI_WEB_AUTH = prev;
  }
});
