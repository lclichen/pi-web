import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { verifyZipStructure } = await jiti.import("./bundle-file-check.ts");

/**
 * Large streamed uploads skip the full JSZip parse (it needs the archive in
 * memory). The structural check must still reject truncation and non-zip
 * content, and accept real archives including empty ones.
 */

const dir = mkdtempSync(join(tmpdir(), "zipcheck-"));

test("accepts a real zip (and an empty archive)", async () => {
  const zip = new JSZip();
  zip.file("AGENTS.md", "# demo");
  zip.file(".pi/bundle.json", "{}");
  const p = join(dir, "ok.zip");
  writeFileSync(p, await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual(verifyZipStructure(p), { ok: true });

  const empty = join(dir, "empty.zip");
  writeFileSync(empty, await new JSZip().generateAsync({ type: "nodebuffer" }));
  assert.deepEqual(verifyZipStructure(empty), { ok: true });
});

test("rejects a truncated archive (no central directory)", async () => {
  const zip = new JSZip();
  zip.file("a.txt", "x".repeat(1024));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const p = join(dir, "truncated.zip");
  writeFileSync(p, buf.subarray(0, Math.floor(buf.length / 2)));
  const res = verifyZipStructure(p);
  assert.equal(res.ok, false);
  assert.match(res.reason, /中央目录|截断|过小/);
});

test("rejects non-zip content", () => {
  const p = join(dir, "not.zip");
  writeFileSync(p, Buffer.from("APKG1 something else entirely...."));
  const res = verifyZipStructure(p);
  assert.equal(res.ok, false);
  assert.match(res.reason, /zip/);
});
