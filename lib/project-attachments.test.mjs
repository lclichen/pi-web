import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./project-attachments.ts");
}

test("measures the Host attachment store recursively and cleans it", async () => {
  const { projectAttachmentsDir, measureAttachments, cleanAttachments } = await loadSubject();
  const home = mkdtempSync(join(tmpdir(), "proj-attach-"));
  try {
    const dir = projectAttachmentsDir(home);
    assert.equal(dir, join(home, ".pi", "attachments"));
    assert.deepEqual(measureAttachments(dir), { bytes: 0, files: 0 });

    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.png"), Buffer.alloc(10));
    writeFileSync(join(dir, "nested", "b.txt"), Buffer.alloc(5));
    assert.deepEqual(measureAttachments(dir), { bytes: 15, files: 2 });

    assert.deepEqual(cleanAttachments(dir), { ok: true, bytes: 15, files: 2 });
    assert.equal(existsSync(dir), false);
    // Cleaning an absent store is a no-op, not an error.
    assert.deepEqual(cleanAttachments(dir), { ok: true, bytes: 0, files: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("refuses a symlinked store so a tampered home cannot redirect the delete", async () => {
  const { projectAttachmentsDir, cleanAttachments } = await loadSubject();
  const home = mkdtempSync(join(tmpdir(), "proj-attach-link-"));
  const outside = mkdtempSync(join(tmpdir(), "proj-attach-outside-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "keep");
    mkdirSync(join(home, ".pi"), { recursive: true });
    symlinkSync(outside, projectAttachmentsDir(home), process.platform === "win32" ? "junction" : "dir");

    const result = cleanAttachments(projectAttachmentsDir(home));
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(outside, "keep.txt")), true, "outside data survives");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writes atomically, replaces an existing file, and leaves no temp files", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { writeAttachmentAtomic } = await loadSubject();
  const dir = mkdtempSync(join(tmpdir(), "proj-attach-atomic-"));
  try {
    writeAttachmentAtomic(dir, "a.png", Buffer.from("old"));
    writeAttachmentAtomic(dir, "a.png", Buffer.from("new"));
    assert.equal(readFileSync(join(dir, "a.png"), "utf8"), "new");
    assert.deepEqual(readdirSync(dir), ["a.png"], "no .upload-* temp survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
