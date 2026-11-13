import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./sync-backups.ts");
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "sync-backup-"));
  mkdirSync(join(home, ".pi", "skills", "lint"), { recursive: true });
  writeFileSync(join(home, ".pi", "skills", "lint", "SKILL.md"), "old skill\n");
  writeFileSync(join(home, ".pi", "settings.json"), '{"old":true}\n');
  return home;
}

const writes = [
  { rel: ".pi/skills/lint/SKILL.md", content: Buffer.from("new skill\n"), existed: true },
  { rel: ".pi/skills/new/SKILL.md", content: Buffer.from("added\n"), existed: false },
];

test("apply backs up old files and atomically replaces them", async () => {
  const { applyPlannedWrites, backupRoot } = await loadSubject();
  const home = makeHome();
  try {
    const { applyId, backupDir } = await applyPlannedWrites(home, writes, { projectId: "p1", workspaceKey: "wk" });
    assert.equal(readFileSync(join(home, ".pi/skills/lint/SKILL.md"), "utf8"), "new skill\n");
    assert.equal(readFileSync(join(home, ".pi/skills/new/SKILL.md"), "utf8"), "added\n");
    assert.ok(existsSync(join(backupDir, "manifest.json")));
    assert.equal(readFileSync(join(backupDir, "files", ".pi/skills/lint/SKILL.md"), "utf8"), "old skill\n");
    assert.ok(existsSync(join(backupRoot(home), applyId)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rollback restores old content, deletes added files, and can be undone", async () => {
  const { applyPlannedWrites, rollbackWorkspaceConfig } = await loadSubject();
  const home = makeHome();
  try {
    const { applyId } = await applyPlannedWrites(home, writes);
    const first = await rollbackWorkspaceConfig(home, applyId);
    assert.equal(first.restored, 1);
    assert.equal(first.deleted, 1);
    assert.equal(readFileSync(join(home, ".pi/skills/lint/SKILL.md"), "utf8"), "old skill\n");
    assert.equal(existsSync(join(home, ".pi/skills/new/SKILL.md")), false);

    // Roll back the rollback: the sync version comes back, including the file
    // that the rollback had deleted (it was backed up as a delete record).
    await rollbackWorkspaceConfig(home, first.applyId);
    assert.equal(readFileSync(join(home, ".pi/skills/lint/SKILL.md"), "utf8"), "new skill\n");
    assert.equal(readFileSync(join(home, ".pi/skills/new/SKILL.md"), "utf8"), "added\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rollback refuses to overwrite a file changed after the apply", async () => {
  const { applyPlannedWrites, rollbackWorkspaceConfig } = await loadSubject();
  const home = makeHome();
  try {
    const { applyId } = await applyPlannedWrites(home, writes);
    writeFileSync(join(home, ".pi/skills/lint/SKILL.md"), "user changed after apply\n");
    await assert.rejects(() => rollbackWorkspaceConfig(home, applyId), /在同步后被修改/);
    // force overrides and still backs up the current state.
    const forced = await rollbackWorkspaceConfig(home, applyId, { force: true });
    assert.equal(readFileSync(join(home, ".pi/skills/lint/SKILL.md"), "utf8"), "old skill\n");
    assert.ok(forced.applyId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup listing is newest first and includes both types", async () => {
  const { applyPlannedWrites, rollbackWorkspaceConfig, listWorkspaceConfigBackups } = await loadSubject();
  const home = makeHome();
  try {
    const { applyId } = await applyPlannedWrites(home, writes);
    const rollback = await rollbackWorkspaceConfig(home, applyId);
    const list = listWorkspaceConfigBackups(home);
    assert.equal(list.length, 2);
    assert.equal(list[0].applyId, rollback.applyId);
    assert.equal(list[1].applyId, applyId);
    assert.equal(list[0].type, "rollback");
    assert.equal(list[1].type, "sync");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
