import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  PRERENDER_MANIFEST,
  freshPreviewSecrets,
  getRotationWarning,
  rotatePreviewSecrets,
} = require("../bin/rotate-preview-secrets.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-preview-"));
  const nextDir = join(root, ".next");
  await mkdir(nextDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, nextDir, manifestPath: join(nextDir, PRERENDER_MANIFEST) };
}

async function writeManifest(path, value) {
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("rotates all three preview secrets and keeps everything else", async (t) => {
  const { nextDir, manifestPath } = await fixture(t);
  const original = {
    version: 4,
    routes: { "/": { initialRevalidateSeconds: false } },
    preview: {
      previewModeId: "a".repeat(32),
      previewModeSigningKey: "b".repeat(64),
      previewModeEncryptionKey: "c".repeat(64),
      extraKey: "kept",
    },
  };
  await writeManifest(manifestPath, original);

  assert.deepEqual(rotatePreviewSecrets(nextDir), { ok: true });
  const rotated = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(rotated.version, 4);
  assert.deepEqual(rotated.routes, original.routes);
  assert.equal(rotated.preview.extraKey, "kept");
  assert.match(rotated.preview.previewModeId, /^[0-9a-f]{32}$/);
  assert.match(rotated.preview.previewModeSigningKey, /^[0-9a-f]{64}$/);
  assert.match(rotated.preview.previewModeEncryptionKey, /^[0-9a-f]{64}$/);
  assert.notEqual(rotated.preview.previewModeId, original.preview.previewModeId);
  assert.notEqual(rotated.preview.previewModeSigningKey, original.preview.previewModeSigningKey);
  assert.notEqual(rotated.preview.previewModeEncryptionKey, original.preview.previewModeEncryptionKey);

  // No temp manifest is left behind.
  assert.deepEqual((await readdir(nextDir)).filter((name) => name.endsWith(".tmp")), []);
});

test("adds a preview block when the manifest has none", async (t) => {
  const { nextDir, manifestPath } = await fixture(t);
  await writeManifest(manifestPath, { version: 4, routes: {} });

  assert.deepEqual(rotatePreviewSecrets(nextDir), { ok: true });
  const rotated = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.match(rotated.preview.previewModeId, /^[0-9a-f]{32}$/);
  assert.match(rotated.preview.previewModeSigningKey, /^[0-9a-f]{64}$/);
  assert.match(rotated.preview.previewModeEncryptionKey, /^[0-9a-f]{64}$/);
});

test("reports missing, unreadable and unexpected manifests without throwing", async (t) => {
  const { nextDir, manifestPath } = await fixture(t);

  assert.deepEqual(rotatePreviewSecrets(nextDir), { ok: false, reason: "missing" });

  await writeManifest(manifestPath, "{not json");
  assert.equal(rotatePreviewSecrets(nextDir).reason, "unreadable");

  await writeManifest(manifestPath, []);
  assert.equal(rotatePreviewSecrets(nextDir).reason, "unexpected-shape");

  await writeManifest(manifestPath, { preview: "nope" });
  assert.equal(rotatePreviewSecrets(nextDir).reason, "unexpected-shape");
});

test("fresh secrets have Next's lengths and differ between calls", () => {
  const first = freshPreviewSecrets();
  const second = freshPreviewSecrets();
  assert.equal(first.previewModeId.length, 32);
  assert.equal(first.previewModeSigningKey.length, 64);
  assert.equal(first.previewModeEncryptionKey.length, 64);
  assert.notEqual(first.previewModeId, second.previewModeId);
});

test("every launch path rotates before next start", async () => {
  const bin = await readFile(new URL("../bin/pi-web.js", import.meta.url), "utf8");
  const startAll = await readFile(new URL("../packaging/start-all.sh", import.meta.url), "utf8");
  const vm = await readFile(new URL("../scripts/vm/lib.cjs", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(bin, /rotatePreviewSecrets\(nextDir\)/);
  assert.ok(bin.indexOf("rotatePreviewSecrets(nextDir)") < bin.indexOf("const nextArgs"));
  assert.match(startAll, /rotate-preview-secrets\.js/);
  assert.match(vm, /rotate-preview-secrets\.js/);
  assert.match(pkg.scripts.prestart, /rotate-preview-secrets\.js/);
});

test("the warning names the bypass when rotation fails", () => {
  assert.match(getRotationWarning("unwritable"), /x-prerender-revalidate/);
  assert.match(getRotationWarning("missing"), /prerender manifest is missing/);
  assert.equal(existsSync(new URL("../bin/rotate-preview-secrets.js", import.meta.url)), true);
});
