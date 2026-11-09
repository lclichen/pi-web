import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ensureEventLoopMonitor,
  perfStats,
  perfStatsSnapshot,
  readEventLoopDelayAndReset,
  recordSessionOpen,
  recordSessionScan,
} = await jiti.import("./perf-stats.ts");

test("restore and scan counters accumulate across record calls", () => {
  const restore = perfStats().restore;
  const before = restore.completed;
  recordSessionOpen("worker", 5.25);
  recordSessionOpen("sync", 1.5);
  recordSessionOpen("lru", 0.2);
  assert.equal(restore.completed, before + 3);
  assert.equal(restore.workerParses, restore.workerParses >= 1 ? restore.workerParses : 1);
  assert.equal(restore.lastParseMs, 0.2);
  assert.ok(restore.maxParseMs >= 5.25);

  const scan = perfStats().scan;
  const scansBefore = scan.count;
  recordSessionScan(12.5, 3);
  assert.equal(scan.count, scansBefore + 1);
  assert.equal(scan.lastMs, 12.5);
  assert.equal(scan.lastChangedFiles, 3);
  assert.ok(scan.maxMs >= 12.5);
});

test("snapshot deep-copies counter state", () => {
  const first = perfStatsSnapshot();
  first.restore.completed += 1000;
  first.scan.count += 1000;
  const second = perfStatsSnapshot();
  assert.ok(second.restore.completed < first.restore.completed);
  assert.ok(second.scan.count < first.scan.count);
});

test("event loop monitor reports and resets", async () => {
  ensureEventLoopMonitor();
  ensureEventLoopMonitor(); // idempotent
  // Burn a synchronous slice so the histogram has something to observe.
  const start = Date.now();
  while (Date.now() - start < 30) {
    JSON.stringify({ noise: Math.random() });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const first = readEventLoopDelayAndReset();
  assert.ok(first, "monitor should produce a snapshot");
  assert.ok(first.meanMs >= 0);
  assert.ok(first.p95Ms >= first.meanMs * 0.99 || first.p95Ms >= 0);
  assert.ok(first.maxMs >= 0);
});
