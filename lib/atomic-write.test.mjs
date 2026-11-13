import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./atomic-write.ts");
}

test("sync atomic write replaces existing content and leaves no temp files", async () => {
  const { atomicWriteFileSync, atomicWriteFile } = await loadSubject();
  const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
  try {
    const target = join(dir, "cfg.json");
    atomicWriteFileSync(target, "one");
    atomicWriteFileSync(target, Buffer.from("two"));
    atomicWriteFile(target, "three");
    assert.equal(readFileSync(target, "utf8"), "three");
    assert.deepEqual(readdirSync(dir), ["cfg.json"], "no .tmp-* survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async atomic write creates parents and replaces content", async () => {
  const { atomicWriteFileAsync } = await loadSubject();
  const dir = mkdtempSync(join(tmpdir(), "atomic-write-async-"));
  try {
    const target = join(dir, "nested", "a.bin");
    await atomicWriteFileAsync(target, Buffer.from([0, 1, 2]));
    await atomicWriteFileAsync(target, Buffer.from([3, 4]));
    assert.deepEqual([...readFileSync(target)], [3, 4]);
    assert.equal(existsSync(join(dir, "nested", "a.bin")), true);
    assert.deepEqual(readdirSync(join(dir, "nested")), ["a.bin"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
