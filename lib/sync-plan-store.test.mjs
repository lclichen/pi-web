import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataRoot = mkdtempSync(join(tmpdir(), "sync-plan-"));
process.env.PI_WEB_DATA_DIR = dataRoot;

const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { saveSyncPlan, loadSyncPlan, consumeSyncPlan, deleteSyncPlan, sweepSyncPlans, cleanupProjectSyncPlans } =
  await jiti.import("./sync-plan-store.ts");

const baseInput = {
  userId: 1,
  projectId: "p1",
  workspaceKey: "wk",
  stats: { files: 2, bytes: 6, added: 1, overwritten: 1, unchanged: 0, skipped: 0, skippedPaths: [] },
  baseline: { ".pi/a.txt": null, ".pi/b.txt": "abc" },
  preview: [{ rel: ".pi/a.txt", change: "added", existed: false, oldBytes: 0, newBytes: 1, binary: false, risk: "normal" }],
  writes: [
    { rel: ".pi/a.txt", content: Buffer.from("a"), existed: false },
    { rel: ".pi/b.txt", content: Buffer.from("new"), existed: true },
  ],
};

test("save/load round-trips the writes, baseline and preview", async () => {
  const { token } = await saveSyncPlan(baseInput);
  const loaded = await loadSyncPlan(token);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.plan.projectId, "p1");
  assert.deepEqual(loaded.plan.baseline, baseInput.baseline);
  assert.equal(loaded.plan.writes.length, 2);
  assert.equal(loaded.plan.writes[1].content.toString(), "new");
  await consumeSyncPlan(token);
  assert.deepEqual(await loadSyncPlan(token), { ok: false, reason: "missing" });
});

test("an unknown or malformed token is missing", async () => {
  assert.deepEqual(await loadSyncPlan("../etc/passwd"), { ok: false, reason: "missing" });
  assert.deepEqual(await loadSyncPlan("A".repeat(32)), { ok: false, reason: "missing" });
});

test("expired plans are rejected", async () => {
  const { token } = await saveSyncPlan(baseInput);
  const dir = join(dataRoot, "sync-plans", token);
  const metaPath = join(dir, "meta.json");
  const fs = await import("node:fs");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.expiresAt = Date.now() - 1;
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  assert.deepEqual(await loadSyncPlan(token), { ok: false, reason: "expired" });
  deleteSyncPlan(token);
});

test("sweep removes expired plans and project cleanup drops its plans", async () => {
  const a = await saveSyncPlan({ ...baseInput, projectId: "p-clean" });
  const b = await saveSyncPlan({ ...baseInput, projectId: "p-keep" });
  // Make A expire by hand.
  const metaPath = join(dataRoot, "sync-plans", a.token, "meta.json");
  const fs = await import("node:fs");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.expiresAt = Date.now() - 1;
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  sweepSyncPlans();
  assert.deepEqual(await loadSyncPlan(a.token), { ok: false, reason: "missing" });
  assert.equal((await loadSyncPlan(b.token)).ok, true);

  cleanupProjectSyncPlans("p-keep");
  assert.deepEqual(await loadSyncPlan(b.token), { ok: false, reason: "missing" });
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});
