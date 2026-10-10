import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Teaching-mode gating (lib/teaching.ts). The flag itself lives in
 * server-settings (data/server-settings.json, env-seeded); these tests pin
 * the two behaviors a general-purpose deployment relies on:
 *   1. the env default flips with PI_WEB_LAB_TRAINING (fresh data dir),
 *   2. the remote-verify bridge (the only unconditional teaching injection
 *      left before 2026-10) is now behind isTeachingEnabled() at every
 *      session-creation site.
 */

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-teaching-"));
  const prevData = process.env.PI_WEB_DATA_DIR;
  const prevLab = process.env.PI_WEB_LAB_TRAINING;
  process.env.PI_WEB_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevData === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = prevData;
    if (prevLab === undefined) delete process.env.PI_WEB_LAB_TRAINING;
    else process.env.PI_WEB_LAB_TRAINING = prevLab;
    await rm(dir, { recursive: true, force: true });
  }
}

test("isTeachingEnabled follows the PI_WEB_LAB_TRAINING env seed on a fresh data dir", async (t) => {
  await withDataDir(async () => {
    delete globalThis.__piServerSettingsStore;
    t.after(() => { delete globalThis.__piServerSettingsStore; });
    process.env.PI_WEB_LAB_TRAINING = "off";
    const { isTeachingEnabled } = await jiti.import("./teaching.ts");
    assert.equal(isTeachingEnabled(), false);
    delete globalThis.__piServerSettingsStore;
    process.env.PI_WEB_LAB_TRAINING = "on";
    assert.equal(isTeachingEnabled(), true);
    delete globalThis.__piServerSettingsStore;
    delete process.env.PI_WEB_LAB_TRAINING;
    // Absent env seeds ON (the historical default; general-purpose packages
    // must ship an explicit `off` — start-all seeds it from pkg-teaching).
    assert.equal(isTeachingEnabled(), true);
  });
});

test("a persisted server-settings value wins over the env", async (t) => {
  await withDataDir(async (dir) => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "server-settings.json"), JSON.stringify({ labTraining: false }));
    delete globalThis.__piServerSettingsStore;
    t.after(() => { delete globalThis.__piServerSettingsStore; });
    process.env.PI_WEB_LAB_TRAINING = "on";
    const { isTeachingEnabled } = await jiti.import("./teaching.ts");
    assert.equal(isTeachingEnabled(), false);
  });
});

test("every remote-verify injection site is gated by isTeachingEnabled", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const newRoute = await read(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const restore = await read(new URL("./session-restore-options.ts", import.meta.url), "utf8");
  const gated = (source) => {
    const sites = [...source.matchAll(/makeRemoteVerifyExtension\(/g)];
    assert.ok(sites.length > 0, "injection sites exist");
    for (const site of sites) {
      const lineStart = source.lastIndexOf("\n", site.index) + 1;
      const line = source.slice(lineStart, source.indexOf("\n", site.index));
      assert.match(line, /isTeachingEnabled\(\) \? \[makeRemoteVerifyExtension/, "gated: " + line.trim());
    }
  };
  gated(newRoute);
  gated(restore);
});

test("teaching constants stay in one place", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const { LAB_WIDGET_KEY, LAB_CUSTOM_TYPE, LAB_TURN_MARKER } = await jiti.import("./teaching.ts");
  assert.equal(LAB_WIDGET_KEY, "lab-training");
  assert.equal(LAB_CUSTOM_TYPE, "lab-training");
  assert.equal(LAB_TURN_MARKER, "【本轮教学信息】");
  // Consumers reference the constants, not their own copies.
  const chatWindow = await read(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindow, /LAB_WIDGET_KEY/);
  assert.doesNotMatch(chatWindow, /"lab-training"/);
  const messageView = await read(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  assert.match(messageView, /LAB_TURN_MARKER/);
  assert.doesNotMatch(messageView, /【本轮教学信息】/);
});
