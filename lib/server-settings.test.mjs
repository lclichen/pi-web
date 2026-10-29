import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Deployment settings: the config-bundle upload cap is seeded from the
 * environment, overridable by an admin at runtime, persisted, and resettable.
 * Invalid values must fail loudly (never silently fall back to a wrong cap).
 */

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "server-settings-"));
process.env.PI_WEB_BUNDLE_UPLOAD_MAX_MB = "300";

// server-settings.ts uses bundler-style extensionless imports — load via jiti
// (same loader the app's tests use), not bare node ESM resolution.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  BUNDLE_UPLOAD_DEFAULT_MB,
  BUNDLE_UPLOAD_CONFIRM_MB,
  getBundleUploadMaxMb,
  getServerSettings,
  normalizeUploadMaxMb,
  updateServerSettings,
} = await jiti.import("./server-settings.ts");

function freshRead() {
  // Simulate a process restart: drop the in-memory cache, re-read the file.
  delete globalThis.__piServerSettingsStore;
}

test("env seeds the bundle cap; the default applies without one", () => {
  assert.equal(getBundleUploadMaxMb(), 300);
  assert.equal(BUNDLE_UPLOAD_CONFIRM_MB, 200);
  assert.ok(BUNDLE_UPLOAD_DEFAULT_MB >= BUNDLE_UPLOAD_CONFIRM_MB);
});

test("admin override persists and survives a restart", () => {
  const updated = updateServerSettings({ bundleUploadMaxMb: 512 });
  assert.equal(updated.bundleUploadMaxMb, 512);
  assert.equal(getBundleUploadMaxMb(), 512);
  freshRead();
  assert.equal(getBundleUploadMaxMb(), 512);
  const stored = JSON.parse(readFileSync(join(process.env.PI_WEB_DATA_DIR, "server-settings.json"), "utf8"));
  assert.equal(stored.bundleUploadMaxMb, 512);
});

test("clearing the override restores the env seed, not a hardcoded number", () => {
  updateServerSettings({ bundleUploadMaxMb: null });
  freshRead();
  assert.equal(getBundleUploadMaxMb(), 300);
  assert.equal(getServerSettings().bundleUploadMaxMb, 300);
});

test("invalid caps are rejected and leave the previous value intact", () => {
  assert.equal(normalizeUploadMaxMb("1024", "x"), 1024);
  assert.equal(normalizeUploadMaxMb(64, "x"), 64);
  assert.equal(normalizeUploadMaxMb("", "x"), undefined);
  assert.equal(normalizeUploadMaxMb(null, "x"), undefined);
  for (const bad of [0, -1, 1.5, 65537, "abc", "12MB"]) {
    assert.throws(() => normalizeUploadMaxMb(bad, "bundleUploadMaxMb"), /bundleUploadMaxMb/);
  }
  updateServerSettings({ bundleUploadMaxMb: 700 });
  assert.throws(() => updateServerSettings({ bundleUploadMaxMb: 0 }), /bundleUploadMaxMb/);
  assert.equal(getBundleUploadMaxMb(), 700);
});
