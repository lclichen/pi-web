import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import JSZip from "jszip";

/**
 * .apkg v2: recipient public metadata, license, locks, sealed decryption.
 *
 * The envelope implementation is NOT part of this repo — decryption runs in
 * the internal apkg-publisher binary (lib/apkg-open.ts spawns it). Tests that
 * need real packages locate the binary (PI_WEB_APKG_TOOL, repo bin/, or the
 * sibling apkg-publisher checkout), SEAL a copy with a test identity, and PACK
 * fixtures with it; when the binary is absent they skip, so public-repo CI
 * still covers the policy layer (license / counters / locks / header parse /
 * degradation errors).
 */

// Isolate server-side state (public metadata + import counters) per test run.
const dataDir = mkdtempSync(join(tmpdir(), "apkg-state-"));
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_APKG_RECIPIENT;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toolCandidates = [
  process.env.PI_WEB_APKG_TOOL,
  join(repoRoot, "bin", "apkg-publisher.exe"),
  join(repoRoot, "bin", "apkg-publisher"),
  join(repoRoot, "..", "apkg-publisher", "apkg-publisher.exe"),
  join(repoRoot, "..", "apkg-publisher", "apkg-publisher"),
].filter(Boolean);
// 发布方完整版（pack/seal）；客户运行版（open/identity show）只作为被封装的基底。
const TOOL = toolCandidates.find((p) => existsSync(p)) ?? null;
const runtimeCandidates = [
  process.env.PI_WEB_APKG_RUNTIME_TOOL,
  join(repoRoot, "bin", "apkg-publisher-runtime.exe"),
  join(repoRoot, "bin", "apkg-publisher-runtime"),
  join(repoRoot, "..", "apkg-publisher", "apkg-publisher-runtime.exe"),
  join(repoRoot, "..", "apkg-publisher", "apkg-publisher-runtime"),
].filter(Boolean);
const RUNTIME_TOOL = runtimeCandidates.find((p) => existsSync(p)) ?? TOOL;

const workshop = mkdtempSync(join(tmpdir(), "apkg-fixtures-"));
const IDENTITY = identityPair();
const IDENTITY_FILE = join(workshop, "identity.json");
writeFileSync(
  IDENTITY_FILE,
  JSON.stringify({ version: 2, id: IDENTITY.id, publicKey: IDENTITY.pub, privateKey: IDENTITY.priv }),
);
const RECIPIENT_FILE = join(workshop, "recipient.json");
writeFileSync(RECIPIENT_FILE, JSON.stringify({ version: 2, id: IDENTITY.id, publicKey: IDENTITY.pub }));
// pi-web only reads the public recipient metadata.
writeFileSync(
  join(dataDir, "apkg-recipient.json"),
  JSON.stringify({ version: 2, id: IDENTITY.id, publicKey: IDENTITY.pub }),
);

/** Seal a copy of the customer runtime binary with the test identity. */
function sealTool(identityFile, outPath) {
  const run = spawnSync(
    TOOL,
    ["seal", "--in", RUNTIME_TOOL, "--identity", identityFile, "--out", outPath, "--force"],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`apkg-publisher seal 失败: ${run.stderr}`);
  return outPath;
}

const SEALED_TOOL = TOOL ? sealTool(IDENTITY_FILE, join(workshop, "apkg-publisher-sealed.exe")) : null;
if (SEALED_TOOL) process.env.PI_WEB_APKG_TOOL = SEALED_TOOL;

const {
  checkApkgLicense,
  recordApkgImport,
  runLicensedApkgImport,
  getApkgImportCount,
  isBundleLocked,
  writeBundleLock,
  bundleLockPath,
  isExportLocked,
  isApkgLockedHome,
  recordApkgLockedHome,
  isApkgBytes,
  readApkgHeader,
  getApkgIdentityInfo,
} = await import("./apkg.ts");
const { openApkgViaTool } = await import("./apkg-open.ts");
const { importProjectConfigBundle, exportProjectConfigBundle } = await import("./project-config-bundle.ts");

function identityPair() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const priv = privateKey.export({ format: "jwk" }).d;
  const id = `r_${createHash("sha256").update(pub).digest("hex").slice(0, 16)}`;
  return { id, pub: pub.toString("base64url"), priv };
}

async function sampleZip(files = { ".pi/agents.json": "{}" }) {
  const zip = new JSZip();
  for (const [rel, content] of Object.entries(files)) zip.file(rel, content);
  zip.file(
    "manifest.json",
    JSON.stringify({
      format: "amedac-project-config",
      version: 2,
      project: "demo",
      package: { name: "demo", title: "演示包", description: "demo description", version: "1.2.0", channel: "stable" },
    }),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function packSample(overrides = {}) {
  assert.ok(TOOL, "tool required");
  const zipPath = join(workshop, "sample.zip");
  const outPath = join(workshop, "sample.apkg");
  writeFileSync(zipPath, overrides.zip ?? readFileSync(zipPath));
  const args = [
    "pack",
    "--in",
    zipPath,
    "--recipient",
    RECIPIENT_FILE,
    "--buyer",
    "customer-semi",
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

test("apkg format: pack → header → memory decryption (via external tool)", { skip: !TOOL }, async () => {
  const { bytes, fingerprint } = await packSampleAsync();
  assert.ok(isApkgBytes(bytes));

  const header = readApkgHeader(bytes);
  assert.equal(header.recipient, IDENTITY.id);
  assert.equal(header.name, "demo");
  assert.equal(header.title, "演示包");
  assert.equal(header.version, "1.2.0");
  assert.equal(header.buyer, "customer-semi");
  assert.match(fingerprint, /^[0-9a-f]{64}$/);

  const zip = await openApkgViaTool(bytes);
  assert.ok(!isApkgBytes(zip));
  const parsed = await JSZip.loadAsync(zip);
  assert.equal(await parsed.file(".pi/agents.json").async("string"), "{}");
  const manifest = JSON.parse(await parsed.file("manifest.json").async("string"));
  assert.equal(manifest.package.name, "demo");
  assert.equal(manifest.apkg.recipient, IDENTITY.id);
});

test("apkg format: tampered header/content fails GCM authentication", { skip: !TOOL }, async () => {
  const { bytes } = await packSampleAsync();
  const corrupted = Buffer.from(bytes);
  corrupted[20] ^= 0xff; // display header JSON is AAD
  await assert.rejects(() => openApkgViaTool(corrupted), /无法解密/);

  const tail = Buffer.from(bytes);
  tail[tail.length - 60] ^= 0xff; // encrypted tail
  await assert.rejects(() => openApkgViaTool(tail), /无法解密/);
});

test("apkg format: another sealed identity is rejected", { skip: !TOOL }, async () => {
  const { bytes } = await packSampleAsync();
  const other = identityPair();
  const otherFile = join(workshop, "other-identity.json");
  writeFileSync(
    otherFile,
    JSON.stringify({ version: 2, id: other.id, publicKey: other.pub, privateKey: other.priv }),
  );
  const otherTool = sealTool(otherFile, join(workshop, "other-sealed.exe"));
  const saved = process.env.PI_WEB_APKG_TOOL;
  process.env.PI_WEB_APKG_TOOL = otherTool;
  try {
    await assert.rejects(() => openApkgViaTool(bytes), /无法解密/);
  } finally {
    if (saved === undefined) delete process.env.PI_WEB_APKG_TOOL;
    else process.env.PI_WEB_APKG_TOOL = saved;
  }
});

test("dev: PI_WEB_APKG_IDENTITY decrypts with an explicit identity file", { skip: !TOOL }, async () => {
  const { bytes } = await packSampleAsync();
  const savedTool = process.env.PI_WEB_APKG_TOOL;
  const savedId = process.env.PI_WEB_APKG_IDENTITY;
  process.env.PI_WEB_APKG_TOOL = TOOL;
  process.env.PI_WEB_APKG_IDENTITY = IDENTITY_FILE;
  try {
    const zip = await openApkgViaTool(bytes);
    assert.ok(zip.length > 100);
  } finally {
    if (savedTool === undefined) delete process.env.PI_WEB_APKG_TOOL;
    else process.env.PI_WEB_APKG_TOOL = savedTool;
    if (savedId === undefined) delete process.env.PI_WEB_APKG_IDENTITY;
    else process.env.PI_WEB_APKG_IDENTITY = savedId;
  }
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
    await assert.rejects(() => openApkgViaTool(Buffer.from("APKG2")), /未启用|不可用|无法解密/);
  } finally {
    if (saved === undefined) delete process.env.PI_WEB_APKG_TOOL;
    else process.env.PI_WEB_APKG_TOOL = saved;
  }
});

test("identity: admin view exposes id/public key and never the private key", () => {
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, true);
  assert.equal(info.id, IDENTITY.id);
  assert.equal(info.publicKey, IDENTITY.pub);
  assert.ok(!JSON.stringify(info).includes(IDENTITY.priv));
  assert.ok(!("path" in info));
  assert.ok(!("source" in info));
});

test("apkg license: expiry and import counter enforced", async () => {
  const fp = "fptest";
  await checkApkgLicense({ expiresAt: "2099-01-01T00:00:00Z" }, fp, { name: "n", version: "1" });
  await assert.rejects(
    () => checkApkgLicense({ expiresAt: "2000-01-01T00:00:00Z" }, fp, { name: "n", version: "1" }),
    /已过期/,
  );
  await checkApkgLicense({ maxImports: 1 }, fp, { name: "n", version: "1" });
  await recordApkgImport(fp);
  assert.equal(getApkgImportCount(fp), 1);
  await assert.rejects(() => checkApkgLicense({ maxImports: 1 }, fp, { name: "n", version: "1" }), /已达上限/);
});

test("import lock: 并发 10 次原子 check+record（maxImports=3）恰通过 3 次、计数恰为 3", async () => {
  const fp = "fp-race";
  const header = { name: "n", version: "1" };
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      runLicensedApkgImport({ maxImports: 3 }, fp, header, async () => {
        // 拉宽 check 与 record 之间的 await 窗口：无锁时 10 次检查会全部通过
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "imported";
      }),
    ),
  );
  const passed = outcomes.filter((o) => o.status === "fulfilled");
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(passed.length, 3);
  assert.equal(rejected.length, 7);
  for (const o of rejected) assert.match(String(o.reason?.message ?? o.reason), /已达上限/);
  assert.equal(getApkgImportCount(fp), 3);
});

test("import lock: 不同指纹互不排队（锁 key 是指纹，不是全局单锁）", async () => {
  const header = { name: "n", version: "1" };
  let releaseSlow;
  const gate = new Promise((resolve) => (releaseSlow = resolve));
  const slow = runLicensedApkgImport({}, "fp-slow", header, () => gate.then(() => "slow-done"));
  const fast = runLicensedApkgImport({}, "fp-fast", header, () => "fast-done");
  // fp-fast 不等待 fp-slow 的 body（解密/解包等重活跨指纹并行）
  assert.equal(await fast, "fast-done");
  releaseSlow();
  assert.equal(await slow, "slow-done");
});

test("import state: 半写损坏的 JSON fail-open 为 {}，原子写覆盖后恢复合法 JSON", async () => {
  const fp = "fp-corrupt";
  const statePath = join(dataDir, "state", "global", "apkg-imports.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, '{"schemaVersion":1,"data":{"fp-corrupt": {"count": 1, "firstAt"'); // 模拟崩溃半写
  assert.equal(getApkgImportCount(fp), 0); // 现有 fail-open 行为保持不变
  await recordApkgImport(fp);
  const parsed = JSON.parse(readFileSync(statePath, "utf8")); // 原子替换后必为合法 JSON
  assert.equal(parsed.data[fp].count, 1);

  // 锁注册表同样：损坏 → fail-open，原子写后恢复
  const registryPath = join(dataDir, "state", "global", "apkg-locked-homes.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, '{"schemaVersion":1,"data":{"broken": tru');
  const home = mkdtempSync(join(tmpdir(), "apkg-lockreg-"));
  try {
    assert.equal(isApkgLockedHome(home), false);
    recordApkgLockedHome(home, { fingerprint: fp, recipient: "r_deadbeefdeadbeef", importedAt: "2026-01-01T00:00:00Z" });
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.ok(registry.data);
    assert.equal(isApkgLockedHome(home), true);
    assert.equal(isExportLocked(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bundle lock: write → locked → path inside .pi/", () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-home-"));
  try {
    assert.equal(isBundleLocked(home), false);
    writeBundleLock(home, {
      apkg: true,
      recipient: IDENTITY.id,
      fingerprint: "x",
      importedAt: new Date().toISOString(),
    });
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
      const stats = await importProjectConfigBundle(home, bytes);
      assert.ok(stats.apkg);
      assert.equal(stats.package.name, "demo");
      assert.equal(stats.package.version, "1.2.0");
      assert.ok(existsSync(join(home, ".pi", "agents.json")));
      assert.ok(isBundleLocked(home));
      assert.equal(getApkgImportCount(fingerprint), 1);
      const lock = JSON.parse(readFileSync(bundleLockPath(home), "utf8"));
      assert.equal(lock.recipient, IDENTITY.id);
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
    await importProjectConfigBundle(home, bytes);
    await assert.rejects(
      () => importProjectConfigBundle(mkdtempSync(join(tmpdir(), "apkg-max2-")), bytes),
      /已达上限/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import: plain bundle cannot smuggle or strip .bundle-lock.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-smug-"));
  try {
    writeBundleLock(home, {
      apkg: true,
      recipient: "r_deadbeefdeadbeef",
      fingerprint: "f",
      importedAt: "2026-01-01T00:00:00Z",
    });
    const zip = new JSZip();
    zip.file(".pi/.bundle-lock.json", JSON.stringify({ apkg: false }));
    zip.file(".pi/agents.json", "{}");
    await importProjectConfigBundle(home, await zip.generateAsync({ type: "nodebuffer" }));
    const lock = JSON.parse(readFileSync(bundleLockPath(home), "utf8"));
    assert.equal(lock.apkg, true);
    assert.equal(lock.recipient, "r_deadbeefdeadbeef");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("export: manifest v2 carries package identity; export options override", async () => {
  const home = mkdtempSync(join(tmpdir(), "apkg-exp-"));
  try {
    const zip0 = new JSZip();
    zip0.file(".pi/skills/s/SKILL.md", "# s");
    zip0.file("manifest.json", JSON.stringify({ format: "amedac-project-config", version: 1 }));
    await importProjectConfigBundle(home, await zip0.generateAsync({ type: "nodebuffer" }));

    const { bytes } = await exportProjectConfigBundle(home, "Demo 项目", {
      package: { version: "2.1.0", description: "课程包" },
    });
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.package.name, "Demo 项目".replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project");
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
    await importProjectConfigBundle(home, bytes);
    assert.equal(isBundleLocked(home), true);
    assert.equal(isExportLocked(home), true);
    rm(bundleLockPath(home));
    assert.equal(isBundleLocked(home), false);
    assert.equal(isApkgLockedHome(home), true);
    assert.equal(isExportLocked(home), true);
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
  const { bytes } = await packSampleAsync({ maxImports: 50 });
  saveBundle("enc-demo", "加密演示", bytes);
  const listed = listBundles().find((b) => b.name === "enc-demo");
  assert.equal(listed.kind, "apkg");
  assert.equal(listed.version, "1.2.0");

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
