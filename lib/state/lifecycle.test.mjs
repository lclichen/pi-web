import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/** Batch 4a: deleting a project/session clears the pi-web sidecars but never
 * the external Host workspace. */

const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createProject, getProject } = await jiti.import("../projects.ts");
const { deleteSessionCascade, deleteProjectCascade } = await jiti.import("./lifecycle.ts");
const { getSessionMeta, recordSessionMeta } = await jiti.import("../session-metas.ts");
const { readSidebarPins, setPinnedProject, setPinnedSession } = await jiti.import("../sidebar-state.ts");
const { recordApkgLockedHome, isApkgLockedHome } = await jiti.import("../apkg.ts");

test.after(() => {
  delete process.env.PI_WEB_DATA_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true });
});

test("project cascade removes sidecars but keeps the Host directory", async () => {
  const external = join(root, "host-workspace");
  mkdirSync(external, { recursive: true });
  const created = await createProject({
    name: "cascade-host",
    ownerId: 1,
    mode: "host",
    workspaceRoot: external,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const project = created.project;

  recordSessionMeta("cascade-session", {
    mode: "host",
    ownerId: 1,
    projectId: project.id,
    ownerName: "admin",
  });
  setPinnedProject(1, `project:${project.id}`, true);
  setPinnedSession(1, "cascade-session", true);
  recordApkgLockedHome(external, {
    fingerprint: "fp-test",
    recipient: "r_test",
    importedAt: "2026-01-01T00:00:00Z",
  });

  const result = await deleteProjectCascade(project);
  assert.deepEqual(result.sessions, ["cascade-session"]);
  assert.equal(getProject(project.id), undefined);
  assert.equal(getSessionMeta("cascade-session"), undefined);
  assert.equal(existsSync(external), true);
  assert.equal(isApkgLockedHome(external), false);
  const pins = readSidebarPins(1);
  assert.equal(pins.pinnedProjects.includes(`project:${project.id}`), false);
  assert.equal(pins.pinnedSessions.includes("cascade-session"), false);
});

test("session cascade clears metadata, pins and fallback attachments", () => {
  recordSessionMeta("owned-session", { mode: "host", ownerId: 2, ownerName: "u2" });
  setPinnedSession(2, "owned-session", true);
  const attachments = join(dataDir, "attachments", "u2", "owned-session");
  mkdirSync(attachments, { recursive: true });

  deleteSessionCascade("owned-session", 2);
  assert.equal(getSessionMeta("owned-session"), undefined);
  assert.equal(readSidebarPins(2).pinnedSessions.includes("owned-session"), false);
  assert.equal(existsSync(attachments), false);
});
