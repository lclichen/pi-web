import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";

/**
 * .apkg encrypted config package: keys, license, locks, external decryption.
 *
 * The envelope implementation is NOT part of this repo — decryption runs in
 * the internal apkg-publisher binary (lib/apkg-open.ts spawns it). Tests that
 * need real packages locate the binary (PI_WEB_APKG_TOOL, repo bin/, or the
 * sibling apkg-publisher checkout) and PACK fixtures with it; when the binary
 * is absent they skip, so public-repo CI still covers the policy layer
 * (license / counters / locks / header parse / degradation errors).
 */

// Isolate the server-side state (key store + import counters) per test run.
const dataDir = mkdtempSync(join(tmpdir(), "apkg-state-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toolCandidates = [
  process.env.PI_WEB_APKG_TOOL,
  join(repoRoot, "bin", "apkg-publisher.exe"),
  join(repoRoot, "bin", "apkg-publisher"),
  join(repoRoot, "..", "apkg-publisher", "apkg-publisher.exe"),
  join(repoRoot, "..", "apkg-publisher", "apkg-publisher"),
].filter(Boolean);
const TOOL = toolCandidates.find((p) => existsSync(p)) ?? null;
if (TOOL) process.env.PI_WEB_APKG_TOOL ??= TOOL;

const {
  getApkgKeys,
  checkApkgLicense,
  recordApkgImport,
  getApkgImportCount,
  isBundleLocked,
  writeBundleLock,
  bundleLockPath,
  isExportLocked,
  isApkgLockedHome,
  isApkgBytes,
  readApkgHeader,
} = await import("./apkg.ts");
const { openApkgViaTool } = await import("./apkg-open.ts");
const { importProjectConfigBundle, exportProjectConfigBundle } = await import("./project-config-bundle.ts");

const KEK = Buffer.alloc(32, 7);
const KEK2 = Buffer.alloc(32, 9);

// Fixture workshop: sample zips, the test key store, and (when the tool is
// available) real packages packed by the same binary production decrypts with.
const workshop = mkdtempSync(join(tmpdir(), "apkg-fixtures-"));
const KEYS_FILE = join(workshop, "test-keys.json");
writeFileSync(KEYS_FILE, JSON.stringify({ ktest1: KEK.toString("base64") }));

async function sampleZip(files = { ".pi/agents.json": "{}" }) {
  const zip = new JSZip();
  for (const [rel, content] of Object.entries(files)) zip.file(rel, content);
  zip.file("manifest.json", JSON.stringify({ format: "amedac-project-config", version: 2, project: "demo" }));
  return zip.generateAsync({ type: "nodebuffer" });
}

function packSample(overrides = {}) {
  assert.ok(TOOL, "tool required");
  const zipPath = join(workshop, "sample.zip");
  const outPath = join(workshop, "sample.apkg");
  const args = [
    "pack",
    "--in",
    zipPath,
    "--keys",
    KEYS_FILE,
    "--key-id",
    "ktest1",
    "--name",
    "demo",
    "--title",
    "演示包",
    "--version",
    "1.2.0",
    "--out",
    outPath,
  ];
  if (overrides.expiresAt) args.push("--expires", overrides.expiresAt.slice(0, 10));
  if (overrides.maxImports) args.push("--max-imports", String(overrides.maxImports));
  const run = spawnSync(TOOL, args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`apkg-publisher pack 失败: ${run.stderr}`);
  const bytes = readFileSync(outPath);
  return { bytes, fingerprint: createHash("sha256").update(bytes).digest("hex") };
}

async function packSampleAsync(overrides = {}) {
  writeFileSync(join(workshop, "sample.zip"), await sampleZip());
  return packSample(overrides);
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workshop, { recursive: true, force: true });
});

test("apkg format: pack → magic/header → import roundtrip (via external tool)", { skip: !TOOL }, async () => {
  const { bytes, fingerprint } = await packSampleAsync();
  assert.ok(isApkgBytes(bytes));

  const header = readApkgHeader(bytes);
  assert.equal(header.keyId, "ktest1");
  assert.equal(header.name, "demo");
  assert.equal(header.version, "1.2.0");
  assert.match(fingerprint, /^[0-9a-f]{64}$/);

  const zip = await openApkgViaTool(bytes, { ktest1: KEK });
  assert.ok(!isApkgBytes(zip));
  const parsed = await JSZip.loadAsync(zip);
  assert.equal(await parsed.file(".pi/agents.json").async("string"), "{}");
  // The packer injects the authoritative license + package blocks.
  const manifest = JSON.parse(await parsed.file("manifest.json").async("string"));
  assert.equal(manifest.package.name, "demo");
  assert.equal(manifest.apkg.keyId, "ktest1");
  assert.equal(manifest.apkg.license.maxImports, undefined);
});

test("apkg format: tampered content fails the GCM tag", { skip: !TOOL }, async () => {
  const { bytes } = await packSampleAsync();
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 60] ^= 0xff; // flip a byte in the encrypted tail
  await assert.rejects(() => openApkgViaTool(corrupted, { ktest1: KEK }), /篡改|解密失败/);
});

test("apkg format: unknown keyId is rejected (revocation by key removal)", { skip: !TOOL }, async () => {
  const { bytes } = await packSampleAsync();
  await assert.rejects(() => openApkgViaTool(bytes, { other: KEK2 }), /未配置.*ktest1/);
});

test("apkg format: header carries injected license terms", { skip: !TOOL }, async () => {
  const { bytes } = await packSampleAsync({ expiresAt: "2099-01-01T00:00:00Z", maxImports: 3 });
  const header = readApkgHeader(bytes);
  assert.ok(header.license.expiresAt?.startsWith("2099-01-01"));
  assert.equal(header.license.maxImports, 3);
});

test("apkg degradation: missing/broken decryption component yields an explicit error", async () => {
  const saved = process.env.PI_WEB_APKG_TOOL;
  process.env.PI_WEB_APKG_TOOL = join(dataDir, "no-such-tool");
  try {
    await assert.rejects(() => openApkgViaTool(Buffer.from("APKG1"), {}), /解密组件/);
  } finally {
    if (saved === undefined) delete process.env.PI_WEB_APKG_TOOL;
    else process.env.PI_WEB_APKG_TOOL = saved;
  }
});

test("apkg server: key store loads from env JSON", async () => {
  process.env.PI_WEB_APKG_KEYS = JSON.stringify({ envkey: Buffer.alloc(32, 3).toString("base64") });
  const keys = getApkgKeys();
  assert.ok(keys.envkey && keys.envkey.length === 32);
  delete process.env.PI_WEB_APKG_KEYS;
});

test("apkg license: expiry and import counter enforced", async () => {
  const fp = "fptest";
  checkApkgLicense({ expiresAt: "2099-01-01T00:00:00Z" }, fp, { name: "n", version: "1" });
  assert.throws(
    () => checkApkgLicense({ expiresAt: "2000-01-01T00:00:00Z" }, fp, { name: "n", version: "1" }),
    /已过期/,
  );
  // First import of maxImports=1 passes; after recording it, the next is refused.
  checkApkgLicense({ maxImports: 1 }, fp, { name: "n", version: "1" });
  recordApkgImport(fp);
  assert.equal(getApkgImportCount(fp), 1);
  assert.throws(() => checkApkgLicense({ maxImports: 1 }, fp, { name: "n", version: "1" }), /已达上限/);
});

test("bundle lock: write → locked → path inside .pi/", () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-home-"));
  try {
    assert.equal(isBundleLocked(home), false);
    writeBundleLock(home, { apkg: true, keyId: "ktest1", fingerprint: "x", importedAt: new Date().toISOString() });
    assert.equal(isBundleLocked(home), true);
    assert.ok(bundleLockPath(home).endsWith(join(".pi", ".bundle-lock.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "import: .apkg end-to-end — files land, lock written, counter bumped, package meta returned",
  { skip: !TOOL },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "apkg-imp-"));
    try {
      const { bytes, fingerprint } = await packSampleAsync({ maxImports: 5 });
      const stats = await importProjectConfigBundle(home, bytes, { apkgKeys: { ktest1: KEK } });
      assert.ok(stats.apkg);
      assert.equal(stats.package.name, "demo");
      assert.equal(stats.package.version, "1.2.0");
      assert.ok(existsSync(join(home, ".pi", "agents.json")));
      assert.ok(isBundleLocked(home));
      assert.equal(getApkgImportCount(fingerprint), 1);
      const lock = JSON.parse(readFileSync(bundleLockPath(home), "utf8"));
      assert.equal(lock.keyId, "ktest1");
      assert.equal(lock.fingerprint, fingerprint);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("import: maxImports=1 second import rejected, project untouched", { skip: !TOOL }, async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-max-"));
  try {
    const { bytes } = await packSampleAsync({ maxImports: 1 });
    await importProjectConfigBundle(home, bytes, { apkgKeys: { ktest1: KEK } });
    await assert.rejects(
      () => importProjectConfigBundle(mkdtempSync(join(tmpdir(), "apkg-max2-")), bytes, { apkgKeys: { ktest1: KEK } }),
      /已达上限/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import: plain bundle cannot smuggle or strip .bundle-lock.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-smug-"));
  try {
    writeBundleLock(home, { apkg: true, keyId: "k", fingerprint: "f", importedAt: "2026-01-01T00:00:00Z" });
    const zip = new JSZip();
    zip.file(".pi/.bundle-lock.json", JSON.stringify({ apkg: false }));
    zip.file(".pi/agents.json", "{}");
    await importProjectConfigBundle(home, await zip.generateAsync({ type: "nodebuffer" }));
    // Denied basename: the smuggled lock never landed; the real lock survives.
    const lock = JSON.parse(readFileSync(bundleLockPath(home), "utf8"));
    assert.equal(lock.apkg, true);
    assert.equal(lock.keyId, "k");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("export: manifest v2 carries package identity; export options override", async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-exp-"));
  try {
    writeFileSync(join(home, "agents.json"), "x"); // ignored (root file, not AGENTS.md)
    const zip0 = new JSZip();
    zip0.file(".pi/skills/s/SKILL.md", "# s");
    zip0.file("manifest.json", JSON.stringify({ format: "amedac-project-config", version: 1 }));
    // Build a home with real .pi content via import instead.
    await importProjectConfigBundle(home, await zip0.generateAsync({ type: "nodebuffer" }));

    const { bytes } = await exportProjectConfigBundle(home, "Demo 项目", {
      package: { version: "2.1.0", description: "课程包" },
    });
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.package.name, "Demo 项目".replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project"); // slug
    assert.equal(manifest.package.version, "2.1.0");
    assert.equal(manifest.package.description, "课程包");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("routes: both export endpoints check the bundle lock (source contract)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const projectRoute = rf(new URL("../app/api/projects/[id]/config-export/route.ts", import.meta.url), "utf8");
  const hostRoute = rf(new URL("../app/api/host/config-export/route.ts", import.meta.url), "utf8");
  for (const [name, src] of [
    ["project", projectRoute],
    ["host", hostRoute],
  ]) {
    assert.ok(src.includes("isExportLocked"), `${name}: must use the double gate (lock file + server registry)`);
    assert.ok(!src.includes("isBundleLocked"), `${name}: single-file check is bypassable by the agent`);
    assert.match(src, /不允许再导出/, `${name}: 403 message required`);
  }
});

test("agent bypass: deleting the in-home lock does not unlock the server registry", { skip: !TOOL }, async () => {
  const { rmSync: rm, mkdtempSync: mkd } = await import("node:fs");
  const home = mkd(join(tmpdir(), "apkg-bypass-"));
  try {
    const { bytes } = await packSampleAsync({ maxImports: 10 });
    await importProjectConfigBundle(home, bytes, { apkgKeys: { ktest1: KEK } });
    assert.equal(isBundleLocked(home), true);
    assert.equal(isExportLocked(home), true);

    // "删除 .pi/.bundle-lock.json" — what the session agent can do with its
    // own file tools. The server-side registry must keep the export locked.
    rm(bundleLockPath(home));
    assert.equal(isBundleLocked(home), false);
    assert.equal(isApkgLockedHome(home), true);
    assert.equal(isExportLocked(home), true);

    // A home that never imported an .apkg stays freely exportable.
    const clean = mkd(join(tmpdir(), "apkg-clean-"));
    try {
      assert.equal(isExportLocked(clean), false);
    } finally {
      rm(clean, { recursive: true, force: true });
    }
  } finally {
    rm(home, { recursive: true, force: true });
  }
});

test("store: encrypted presets keep ciphertext, kind/version surface", { skip: !TOOL }, async () => {
  const { saveBundle, listBundles, applyBundleToDirectory, deleteBundle } = await import("./config-bundles-store.ts");
  // Server-side key store must know the package generation for applies.
  writeFileSync(join(dataDir, "apkg-keys.json"), JSON.stringify({ ktest1: KEK.toString("base64") }));
  const { bytes } = await packSampleAsync({ maxImports: 50 });
  saveBundle("enc-demo", "加密演示", bytes);
  const listed = listBundles().find((b) => b.name === "enc-demo");
  assert.equal(listed.kind, "apkg");
  assert.equal(listed.version, "1.2.0");

  // Apply path works without the plaintext ever being stored.
  const home = mkdtempSync(join(tmpdir(), "apkg-apply-"));
  try {
    await applyBundleToDirectory("enc-demo", home);
    assert.ok(existsSync(join(home, ".pi", "agents.json")));
    assert.ok(isBundleLocked(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.ok(deleteBundle("enc-demo"));
});
