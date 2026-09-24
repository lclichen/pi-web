import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";

/** .apkg encrypted config package: format, keys, license, locks. */

// Isolate the server-side state (key store + import counters) per test run.
const dataDir = mkdtempSync(join(tmpdir(), "apkg-state-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const { packApkg, openApkgBytes, isApkgBytes, readApkgHeader } = await import("./apkg-format.ts");
const {
  getApkgKeys, checkApkgLicense, recordApkgImport, getApkgImportCount,
  isBundleLocked, writeBundleLock, bundleLockPath,
} = await import("./apkg.ts");
const { importProjectConfigBundle, exportProjectConfigBundle } = await import("./project-config-bundle.ts");

const KEK = Buffer.alloc(32, 7);
const KEK2 = Buffer.alloc(32, 9);

async function sampleZip(files = { ".pi/agents.json": "{}" }) {
  const zip = new JSZip();
  for (const [rel, content] of Object.entries(files)) zip.file(rel, content);
  zip.file("manifest.json", JSON.stringify({ format: "amedac-project-config", version: 2, project: "demo" }));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function packSample(overrides = {}) {
  return packApkg(await sampleZip(), {
    package: { name: "demo", title: "演示包", description: "", version: "1.2.0", channel: "stable" },
    kek: KEK,
    keyId: "ktest1",
    ...overrides,
  });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("apkg format: pack → magic/header → open roundtrip", async () => {
  const { bytes, fingerprint } = await packSample();
  assert.ok(isApkgBytes(bytes));
  assert.match(fingerprint, /^[0-9a-f]{64}$/);

  const header = readApkgHeader(bytes);
  assert.equal(header.keyId, "ktest1");
  assert.equal(header.name, "demo");
  assert.equal(header.version, "1.2.0");
  // The fingerprint (sha256 of the whole file) is external identity — the
  // open path recomputes it and it must equal the packer's value.
  assert.equal(openApkgBytes(bytes, { ktest1: KEK }).fingerprint, fingerprint);

  const opened = openApkgBytes(bytes, { ktest1: KEK });
  assert.ok(!isApkgBytes(opened.zip));
  const zip = await JSZip.loadAsync(opened.zip);
  assert.equal(await zip.file(".pi/agents.json").async("string"), "{}");
  // The packer injects the authoritative license + package blocks.
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.package.name, "demo");
  assert.equal(manifest.apkg.keyId, "ktest1");
  assert.equal(manifest.apkg.license.maxImports, undefined);
});

test("apkg format: tampered content fails the GCM tag", async () => {
  const { bytes } = await packSample();
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 60] ^= 0xff; // flip a ciphertext byte
  assert.throws(() => openApkgBytes(corrupted, { ktest1: KEK }), /解密失败|篡改/);
});

test("apkg format: unknown keyId is rejected (revocation by key removal)", async () => {
  const { bytes } = await packSample();
  assert.throws(() => openApkgBytes(bytes, { other: KEK2 }), /未配置.*ktest1/);
});

test("apkg format: header carries injected license terms", async () => {
  const { bytes } = await packSample({ license: { expiresAt: "2099-01-01T00:00:00Z", maxImports: 3 } });
  const header = readApkgHeader(bytes);
  assert.equal(header.license.expiresAt, "2099-01-01T00:00:00Z");
  assert.equal(header.license.maxImports, 3);
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
  assert.throws(
    () => checkApkgLicense({ maxImports: 1 }, fp, { name: "n", version: "1" }),
    /已达上限/,
  );
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

test("import: .apkg end-to-end — files land, lock written, counter bumped, package meta returned", async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-imp-"));
  try {
    const { bytes, fingerprint } = await packSample({ license: { maxImports: 5 } });
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
});

test("import: maxImports=1 second import rejected, project untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-max-"));
  try {
    const { bytes } = await packSample({ license: { maxImports: 1 } });
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
  for (const [name, src] of [["project", projectRoute], ["host", hostRoute]]) {
    assert.ok(src.includes("isBundleLocked"), `${name}: must check bundle lock`);
    assert.match(src, /不允许再导出/, `${name}: 403 message required`);
  }
});

test("store: encrypted presets keep ciphertext, kind/version surface", async () => {
  const { saveBundle, listBundles, applyBundleToDirectory, deleteBundle } = await import("./config-bundles-store.ts");
  // Server-side key store must know the package generation for applies.
  writeFileSync(join(dataDir, "apkg-keys.json"), JSON.stringify({ ktest1: KEK.toString("base64") }));
  const { bytes } = await packSample({ license: { maxImports: 50 } });
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
