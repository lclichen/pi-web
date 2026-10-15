import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The store reads/writes <data>/user-settings/u<id>.json — run in a temp cwd.
const dir = mkdtempSync(join(tmpdir(), "pi-web-user-settings-"));
const originalCwd = process.cwd();
process.chdir(dir);
test.after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

const { getUserSettings, updateUserSettings, askAutoContinueMsFor, askAutoContinueTimeoutMs } =
  await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./user-settings.ts"));

test("defaults to ask-auto-continue OFF (wait indefinitely)", () => {
  assert.deepEqual(getUserSettings(1), { askAutoContinue: false });
  assert.equal(askAutoContinueMsFor(1), undefined);
});

test("one user's switch never touches another user", () => {
  const next = updateUserSettings(1, { askAutoContinue: true });
  assert.equal(next.askAutoContinue, true);
  assert.equal(askAutoContinueMsFor(1), askAutoContinueTimeoutMs());
  assert.deepEqual(getUserSettings(2), { askAutoContinue: false });
  assert.equal(askAutoContinueMsFor(2), undefined);
});

test("turning the switch back off restores indefinite waiting", () => {
  updateUserSettings(1, { askAutoContinue: true });
  updateUserSettings(1, { askAutoContinue: false });
  assert.equal(askAutoContinueMsFor(1), undefined);
});

test("ask timeout defaults to 5 minutes and clamps small env values", () => {
  assert.equal(askAutoContinueTimeoutMs(), 300_000);
  const previous = process.env.PI_WEB_ASK_TIMEOUT_MS;
  process.env.PI_WEB_ASK_TIMEOUT_MS = "1000";
  try {
    assert.equal(askAutoContinueTimeoutMs(), 5_000);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_ASK_TIMEOUT_MS;
    else process.env.PI_WEB_ASK_TIMEOUT_MS = previous;
  }
});
