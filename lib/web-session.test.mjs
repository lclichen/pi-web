import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Retention semantics of the multi-user login session (lib/web-session.ts):
 * 7-day sliding idle window + 90-day absolute cap, throttled cookie re-issue.
 * Tests run against a temp data dir (PI_WEB_DATA_DIR) and reach into the
 * globalThis session store to backdate timestamps — the same trick the
 * module itself uses for hot-reload safety.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-websession-test-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const user = { id: 1, username: "u", email: null, role: "user", status: "active" };

async function loadSubject() {
  return import("./web-session.ts");
}

function storeOf(mod) {
  // Force store init, then hand back the live map for timestamp surgery.
  mod.createWebSession; // eslint-disable-line no-unused-expressions
  const g = globalThis;
  return g.__piWebSessions;
}

function requestWith(sid) {
  return new Request("http://x/api", { headers: { cookie: `pi_web_sid=${sid}` } });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("resolveSessionTtls: defaults, overrides, invalid values, absolute>=idle clamp", async () => {
  const { resolveSessionTtls } = await loadSubject();
  assert.deepEqual(resolveSessionTtls({}), { idleTtlMs: 7 * DAY, absoluteTtlMs: 90 * DAY });
  assert.deepEqual(
    resolveSessionTtls({ PI_WEB_SESSION_IDLE_DAYS: "3", PI_WEB_SESSION_ABSOLUTE_DAYS: "30" }),
    { idleTtlMs: 3 * DAY, absoluteTtlMs: 30 * DAY },
  );
  // Invalid values fall back to defaults.
  assert.deepEqual(resolveSessionTtls({ PI_WEB_SESSION_IDLE_DAYS: "abc" }).idleTtlMs, 7 * DAY);
  assert.deepEqual(resolveSessionTtls({ PI_WEB_SESSION_IDLE_DAYS: "0" }).idleTtlMs, 7 * DAY);
  // Absolute below idle is clamped up (the cap must not expire faster than idle).
  const clamped = resolveSessionTtls({ PI_WEB_SESSION_IDLE_DAYS: "14", PI_WEB_SESSION_ABSOLUTE_DAYS: "7" });
  assert.deepEqual(clamped, { idleTtlMs: 14 * DAY, absoluteTtlMs: 14 * DAY });
});

test("fresh session is valid; getWebSession slides lastSeenAt", async () => {
  const mod = await loadSubject();
  const session = mod.createWebSession(user, "sk_x", 1);
  const seen = mod.getWebSession(requestWith(session.sid));
  assert.ok(seen);
  assert.ok(seen.lastSeenAt >= session.createdAt);
});

test("idle window is sliding: 6-day-old activity survives, 8-day-old activity expires", async () => {
  const mod = await loadSubject();
  const session = mod.createWebSession(user, "sk_x", 1);
  const store = storeOf(mod);
  store.get(session.sid).lastSeenAt = Date.now() - 6 * DAY;
  assert.ok(mod.getWebSession(requestWith(session.sid)), "6d idle is inside the 7d window");

  const old = mod.createWebSession(user, "sk_y", 2);
  store.get(old.sid).lastSeenAt = Date.now() - 8 * DAY;
  assert.equal(mod.getWebSession(requestWith(old.sid)), null, "8d idle expires");
});

test("absolute cap forces re-login even with recent activity", async () => {
  const mod = await loadSubject();
  const session = mod.createWebSession(user, "sk_x", 1);
  const store = storeOf(mod);
  store.get(session.sid).createdAt = Date.now() - 91 * DAY;
  store.get(session.sid).lastSeenAt = Date.now() - HOUR;
  assert.equal(mod.getWebSession(requestWith(session.sid)), null, "91d-old login expires despite activity");
});

test("cookie refresh header: throttled to >=1h, Max-Age follows idle window", async () => {
  const mod = await loadSubject();
  const session = mod.createWebSession(user, "sk_x", 1);
  // Right after login the cookie is fresh — no re-issue.
  assert.equal(mod.sessionCookieRefreshHeader(requestWith(session.sid)), null);

  const store = storeOf(mod);
  store.get(session.sid).cookieRefreshedAt = Date.now() - 2 * HOUR;
  const header = mod.sessionCookieRefreshHeader(requestWith(session.sid));
  assert.ok(header, "due refresh returns a Set-Cookie header");
  assert.match(header, /^pi_web_sid=/);
  assert.match(header, /Max-Age=604800/, "Max-Age is the full 7-day idle window");
  // Immediately repeated call is throttled again.
  assert.equal(mod.sessionCookieRefreshHeader(requestWith(session.sid)), null);
});

test("cookie Max-Age never exceeds the remaining absolute cap", async () => {
  const mod = await loadSubject();
  const session = mod.createWebSession(user, "sk_x", 1);
  const store = storeOf(mod);
  // Login 89 days ago, active today: 1 day left on the absolute cap.
  store.get(session.sid).createdAt = Date.now() - 89 * DAY;
  store.get(session.sid).lastSeenAt = Date.now();
  store.get(session.sid).cookieRefreshedAt = Date.now() - 2 * HOUR;
  const header = mod.sessionCookieRefreshHeader(requestWith(session.sid));
  assert.ok(header);
  const maxAge = Number(/Max-Age=(\d+)/.exec(header)[1]);
  assert.ok(maxAge > 0 && maxAge <= DAY / 1000, `Max-Age ≈ 1 day, got ${maxAge}s`);
});

test("change-ticket sessions never get cookie refreshes", async () => {
  const mod = await loadSubject();
  const session = mod.createWebSession(user, "", "", "ticket-1");
  const store = storeOf(mod);
  store.get(session.sid).cookieRefreshedAt = Date.now() - 2 * HOUR;
  assert.equal(mod.sessionCookieRefreshHeader(requestWith(session.sid)), null);
});

test("persisted sessions reload after restart; expired ones are dropped", async () => {
  const mod = await loadSubject();
  const alive = mod.createWebSession(user, "sk_alive", 1);
  const dead = mod.createWebSession(user, "sk_dead", 2);
  const store = storeOf(mod);
  store.get(dead.sid).lastSeenAt = Date.now() - 8 * DAY;
  // Force a persist that includes the backdated session (refresh path persists).
  store.get(alive.sid).cookieRefreshedAt = Date.now() - 2 * HOUR;
  mod.sessionCookieRefreshHeader(requestWith(alive.sid));

  // Simulate a restart: drop the in-memory store, next access reloads from disk.
  const g = globalThis;
  g.__piWebSessions = undefined;
  assert.ok(mod.getWebSession(requestWith(alive.sid)), "valid session survives the reload");
  assert.equal(mod.getWebSession(requestWith(dead.sid)), null, "expired session is not loaded back");
});

test("sessionCookieHeader keeps HttpOnly + SameSite=Lax and optional Secure", async () => {
  const mod = await loadSubject();
  const base = mod.sessionCookieHeader("sid-1");
  assert.match(base, /HttpOnly/);
  assert.match(base, /SameSite=Lax/);
  assert.doesNotMatch(base, /Secure/);
  const prev = process.env.PI_WEB_COOKIE_SECURE;
  process.env.PI_WEB_COOKIE_SECURE = "on";
  try {
    assert.match(mod.sessionCookieHeader("sid-1"), /Secure/);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_COOKIE_SECURE;
    else process.env.PI_WEB_COOKIE_SECURE = prev;
  }
});
