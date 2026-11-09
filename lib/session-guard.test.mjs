import assert from "node:assert/strict";
import test from "node:test";
import { getHeapStatistics } from "node:v8";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  checkSessionQuota,
  evictIdleSessionsUnderPressure,
  heapGuardLimitBytes,
  maxLiveSessions,
  maxSessionsPerUser,
} = await jiti.import("./session-guard.ts");

const ENV_KEYS = [
  "PI_WEB_MAX_SESSIONS_PER_USER",
  "PI_WEB_MAX_LIVE_SESSIONS",
  "PI_WEB_SESSION_HEAP_GUARD_MB",
];

function withEnv(t, overrides) {
  const previous = {};
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("session creation caps read their env knobs with sane defaults", (t) => {
  withEnv(t, {});
  assert.equal(maxSessionsPerUser(), 8);
  assert.equal(maxLiveSessions(), 400);

  process.env.PI_WEB_MAX_SESSIONS_PER_USER = "3";
  process.env.PI_WEB_MAX_LIVE_SESSIONS = "600";
  assert.equal(maxSessionsPerUser(), 3);
  assert.equal(maxLiveSessions(), 600);

  process.env.PI_WEB_MAX_SESSIONS_PER_USER = "0";
  assert.equal(maxSessionsPerUser(), 0, "0 disables the per-user cap");
});

test("quota rejects at the global cap for everyone including admins", (t) => {
  withEnv(t, { PI_WEB_MAX_LIVE_SESSIONS: "2", PI_WEB_MAX_SESSIONS_PER_USER: "1" });
  const globalHit = checkSessionQuota({ userId: 7, role: "user", perUserLive: 0, globalLive: 2 });
  assert.ok(globalHit && globalHit.status === 429);
  assert.match(globalHit.error, /live session limit/);
  const adminHit = checkSessionQuota({ userId: 1, role: "admin", perUserLive: 0, globalLive: 2 });
  assert.ok(adminHit, "admins still hit the global cap");
});

test("quota enforces the per-user cap for users but exempts admins", (t) => {
  withEnv(t, { PI_WEB_MAX_LIVE_SESSIONS: "0", PI_WEB_MAX_SESSIONS_PER_USER: "2" });
  const userHit = checkSessionQuota({ userId: 7, role: "user", perUserLive: 2, globalLive: 5 });
  assert.ok(userHit && userHit.status === 429);
  assert.match(userHit.error, /per-user limit/);

  assert.equal(checkSessionQuota({ userId: 7, role: "user", perUserLive: 1, globalLive: 5 }), null);
  assert.equal(checkSessionQuota({ userId: 1, role: "admin", perUserLive: 9, globalLive: 12 }), null);
});

test("heap guard limit follows env MiB, disables on 0, defaults to 70% of the heap limit", (t) => {
  withEnv(t, { PI_WEB_SESSION_HEAP_GUARD_MB: "1536" });
  assert.equal(heapGuardLimitBytes(), 1536 * 1024 * 1024);

  process.env.PI_WEB_SESSION_HEAP_GUARD_MB = "0";
  assert.equal(heapGuardLimitBytes(), 0, "0 disables the guard");

  delete process.env.PI_WEB_SESSION_HEAP_GUARD_MB;
  const auto = heapGuardLimitBytes();
  const heapLimit = getHeapStatistics().heap_size_limit;
  assert.ok(
    Math.abs(auto - heapLimit * 0.7) <= 1024 * 1024,
    `auto limit should be ~70% of heap limit: ${auto} vs ${heapLimit * 0.7}`,
  );
});

test("eviction sweeps the least-recently-active idle sessions down to the target band", async () => {
  const calls = [];
  let heapUsed = 1000;
  const evicted = await evictIdleSessionsUnderPressure(
    [
      { sessionId: "fresh", lastActiveAt: 900 },
      { sessionId: "old", lastActiveAt: 100 },
      { sessionId: "middle", lastActiveAt: 500 },
    ],
    {
      heapUsedBytes: () => heapUsed,
      // target = 900 * 0.9 = 810
      limitBytes: 900,
      shutdown: (id) => {
        calls.push(id);
        heapUsed -= 120; // freeing becomes visible after each shutdown
        return Promise.resolve();
      },
    },
  );
  assert.deepEqual(evicted, ["old", "middle"]);
  assert.deepEqual(calls, ["old", "middle"], "LRU order, stops once inside the band");
});

test("eviction respects the per-sweep cap and skips entirely when disabled", async () => {
  let heapUsed = 1000;
  const evicted = await evictIdleSessionsUnderPressure(
    Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, lastActiveAt: i })),
    {
      heapUsedBytes: () => heapUsed,
      limitBytes: 900,
      shutdown: () => {
        heapUsed -= 1; // freeing slower than the cap can chase
        return Promise.resolve();
      },
    },
    5,
  );
  assert.equal(evicted.length, 5, "per-sweep cap bounds a stale reading");

  const none = await evictIdleSessionsUnderPressure([{ sessionId: "x", lastActiveAt: 0 }], {
    heapUsedBytes: () => 1e12,
    limitBytes: 0, // disabled
    shutdown: () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(none, []);
});

test("a failing shutdown does not stop the sweep", async () => {
  let heapUsed = 1000;
  const evicted = await evictIdleSessionsUnderPressure(
    [
      { sessionId: "broken", lastActiveAt: 1 },
      { sessionId: "healthy", lastActiveAt: 2 },
    ],
    {
      heapUsedBytes: () => heapUsed,
      limitBytes: 900,
      shutdown: (id) => {
        if (id === "broken") return Promise.reject(new Error("wedged"));
        heapUsed -= 200;
        return Promise.resolve();
      },
    },
  );
  assert.deepEqual(evicted, ["healthy"]);
});
