import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-sidebar-state-"));
const previousDataDir = process.env.PI_WEB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = join(root, "data");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { readSidebarPins, setPinnedProject, setPinnedSession } = await jiti.import("./sidebar-state.ts");

after(async () => {
  if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

test("stores project and session pins per user", async () => {
  assert.deepEqual(readSidebarPins(7), { pinnedProjects: [], pinnedSessions: [] });

  setPinnedProject(7, "project:a", true);
  setPinnedProject(7, "host:/srv/app", true);
  setPinnedSession(7, "s1", true);

  assert.deepEqual(readSidebarPins(7), {
    pinnedProjects: ["host:/srv/app", "project:a"],
    pinnedSessions: ["s1"],
  });
  assert.deepEqual(readSidebarPins(8), { pinnedProjects: [], pinnedSessions: [] });
});

test("new pins go first, unpin removes the entry", async () => {
  setPinnedSession(9, "s1", true);
  setPinnedSession(9, "s2", true);
  assert.deepEqual(readSidebarPins(9).pinnedSessions, ["s2", "s1"]);

  setPinnedSession(9, "s1", true);
  assert.deepEqual(readSidebarPins(9).pinnedSessions, ["s1", "s2"]);

  setPinnedSession(9, "s1", false);
  assert.deepEqual(readSidebarPins(9).pinnedSessions, ["s2"]);
});

test("deduplicates and caps stored values", async () => {
  setPinnedProject(10, "project:a", true);
  setPinnedProject(10, "project:a", true);
  assert.deepEqual(readSidebarPins(10).pinnedProjects, ["project:a"]);

  setPinnedSession(10, "x".repeat(300), true);
  assert.deepEqual(readSidebarPins(10).pinnedSessions, []);
});
