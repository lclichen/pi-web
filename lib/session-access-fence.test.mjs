import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Live-session ownership fence: the registry fast paths (running sessions
 * served from memory) used to skip resolveSessionAccess entirely, so knowing
 * a live session id was enough to read AND drive someone else's session.
 * These tests pin the fence at every such call site.
 */

const ROUTES = [
  "../app/api/agent/[id]/route.ts",
  "../app/api/agent/[id]/events/route.ts",
  "../app/api/sessions/[id]/route.ts",
  "../app/api/sessions/[id]/context/route.ts",
  "../app/api/sessions/[id]/state/route.ts",
];

test("every live-session fast path consults checkLiveSessionAccess", async () => {
  for (const rel of ROUTES) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    assert.match(source, /checkLiveSessionAccess\(/, `${rel} must fence live sessions`);
  }
});

test("the fence allows owner/admin and 404s everyone else", async () => {
  const source = await readFile(new URL("./session-access.ts", import.meta.url), "utf8");
  assert.match(source, /export function checkLiveSessionAccess/);
  // non-owner + non-admin → 404 (existence not disclosed)
  assert.match(
    source,
    /owner\.ownerId !== 0 && owner\.ownerId !== user\.id && user\.role !== "admin"[\s\S]*?status: 404/,
  );
});

test("auto-name and git review already fence through resolveSessionAccess", async () => {
  for (const rel of ["../app/api/sessions/[id]/auto-name/route.ts", "../app/api/git/review/route.ts"]) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    assert.match(source, /resolveSessionAccess\(/, `${rel} must keep its access check`);
  }
});
