import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SM_CACHE_LIMITS,
  invalidateSessionManagerCache,
  openSessionManager,
  openSessionManagerAsync,
  resetSessionOpenForTests,
  sessionParseQueueDepth,
} = await jiti.import("./session-open.ts");
const { sessionPathKey } = await jiti.import("./session-path.ts");
const { perfStats } = await jiti.import("./perf-stats.ts");

const previousMinBytes = process.env.PI_WEB_PARSE_WORKER_MIN_BYTES;
const previousWorkers = process.env.PI_WEB_PARSE_WORKERS;
const previousReapMs = process.env.PI_WEB_PARSE_IDLE_REAP_MS;

function fixture(t, { minBytes = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-session-open-"));
  const sessionDir = path.join(root, "sessions", "project");
  fs.mkdirSync(sessionDir, { recursive: true });
  process.env.PI_WEB_PARSE_WORKER_MIN_BYTES = String(minBytes);
  process.env.PI_WEB_PARSE_WORKERS = "2";
  process.env.PI_WEB_PARSE_IDLE_REAP_MS = "500";
  resetSessionOpenForTests();
  t.after(() => {
    if (previousMinBytes === undefined) delete process.env.PI_WEB_PARSE_WORKER_MIN_BYTES;
    else process.env.PI_WEB_PARSE_WORKER_MIN_BYTES = previousMinBytes;
    if (previousWorkers === undefined) delete process.env.PI_WEB_PARSE_WORKERS;
    else process.env.PI_WEB_PARSE_WORKERS = previousWorkers;
    if (previousReapMs === undefined) delete process.env.PI_WEB_PARSE_IDLE_REAP_MS;
    else process.env.PI_WEB_PARSE_IDLE_REAP_MS = previousReapMs;
    resetSessionOpenForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sessionDir };
}

function writeSession(sessionDir, id, entries = []) {
  const filePath = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionDir }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function userMessage(id, text) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: text } };
}

test("openSessionManager caches read-only managers by fingerprint", async (t) => {
  const { sessionDir } = fixture(t);
  const filePath = writeSession(sessionDir, "cached", [userMessage("m1", "hello")]);

  const first = openSessionManager(filePath);
  const second = openSessionManager(filePath);
  assert.strictEqual(first, second, "unchanged file serves the cached manager");
  // SDK getEntries() excludes the session header itself.
  assert.equal(first.getEntries().length, 1);

  // Appending changes the fingerprint: next open is fresh and sees the entry.
  fs.appendFileSync(filePath, JSON.stringify(userMessage("m2", "more")) + "\n");
  const third = openSessionManager(filePath);
  assert.notStrictEqual(third, first);
  assert.equal(third.getEntries().length, 2);

  // mutable opens never share the cache.
  const mutable = openSessionManager(filePath, { mutable: true });
  assert.notStrictEqual(mutable, third);

  invalidateSessionManagerCache(filePath);
  assert.notStrictEqual(openSessionManager(filePath), third);
});

test("openSessionManagerAsync parses large files on a worker and injects preloaded entries", async (t) => {
  const { sessionDir } = fixture(t, { minBytes: 1 }); // every file goes through the worker
  const entries = Array.from({ length: 50 }, (_, i) => userMessage(`m${i}`, `line ${i}`));
  const filePath = writeSession(sessionDir, "worker", entries);

  const before = perfStats().restore.workerParses;
  const sm = await openSessionManagerAsync(filePath);
  assert.equal(perfStats().restore.workerParses, before + 1, "parsed on a worker");

  // The constructed manager behaves like a synchronous open: same header,
  // same entries, same session id, persisted against the same file.
  assert.equal(sm.getSessionId(), "worker");
  assert.equal(sm.getCwd(), sessionDir);
  // SDK getEntries() excludes the session header itself.
  assert.equal(sm.getEntries().length, entries.length);
  assert.equal(sm.getSessionFile(), filePath);
  assert.equal(sessionParseQueueDepth().active, 0);
  assert.equal(sessionParseQueueDepth().queued, 0);

  // Read-only async open lands in the LRU cache.
  const again = await openSessionManagerAsync(filePath);
  assert.strictEqual(again, sm);
});

test("worker parse of a non-session file falls back to the synchronous open", async (t) => {
  const { sessionDir } = fixture(t, { minBytes: 1 });
  const filePath = path.join(sessionDir, "not-a-session.jsonl");
  fs.writeFileSync(filePath, JSON.stringify({ type: "message", id: "x" }) + "\n");

  // The SDK open is the semantic authority for invalid files: it throws for
  // non-empty files that do not parse as a pi session.
  await assert.rejects(() => openSessionManagerAsync(filePath), /not a valid/);
});

test("cache evicts by entry count and summed bytes", async (t) => {
  const { sessionDir } = fixture(t);
  const { maxEntries } = SM_CACHE_LIMITS;
  const paths = Array.from({ length: maxEntries + 3 }, (_, i) =>
    writeSession(sessionDir, `evict-${i}`, [userMessage(`m${i}`, "x")]),
  );
  const managers = paths.map((p) => openSessionManager(p));
  const cacheSize = globalThis.__piWebSmCache.size;
  assert.ok(cacheSize <= maxEntries, `cache holds at most maxEntries, got ${cacheSize}`);
  // Opened oldest-first, so the earliest `paths.length - cacheSize` were evicted.
  const evictedCount = paths.length - cacheSize;
  const evictedIndex = paths.findIndex((p) => !globalThis.__piWebSmCache.has(sessionPathKey(p)));
  assert.ok(evictedIndex !== -1 && evictedIndex < evictedCount, `expected eviction among the oldest, got index ${evictedIndex}`);
  // The most recently opened managers survive as the same references.
  for (let i = evictedCount; i < paths.length; i += 1) {
    assert.strictEqual(openSessionManager(paths[i]), managers[i]);
  }
});

test("oversize files are served fresh instead of evicting the cache", async (t) => {
  const { sessionDir } = fixture(t);
  const small = writeSession(sessionDir, "small", [userMessage("m1", "x")]);
  const cachedSmall = openSessionManager(small);
  assert.ok(globalThis.__piWebSmCache.has(sessionPathKey(small)));

  const bigEntries = [{ type: "message", id: "b1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "y".repeat(300) } }];
  const big = writeSession(sessionDir, "big", bigEntries);
  // Grow the file past the per-file cap without re-encoding huge JSON lines.
  fs.appendFileSync(big, " ".repeat(SM_CACHE_LIMITS.maxFileBytes) + "\n");

  const freshBig = openSessionManager(big);
  assert.ok(!globalThis.__piWebSmCache.has(sessionPathKey(big)), "oversize file not cached");
  assert.strictEqual(openSessionManager(small), cachedSmall, "small entry survived");
  assert.notStrictEqual(freshBig, undefined);
});
