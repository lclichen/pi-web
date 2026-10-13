import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * apkg 密钥仓（lib/apkg-keys.ts）语义钉子：CLI（pack-apkg.ts）与打包 API
 * （/api/apkg/pack）共用，两端的取钥/建代行为必须一致。
 */

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "apkg-keys-"));
  const storePath = join(dir, "apkg-keys.json");
  try {
    await fn(storePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("fresh store: getOrCreate provisions a generation and persists 0600", async () => {
  await withStore(async (storePath) => {
    const { getOrCreateApkgKek, listApkgKeyIds, getApkgKek } = await jiti.import("./apkg-keys.ts");
    assert.deepEqual(listApkgKeyIds(storePath), []);
    const first = getOrCreateApkgKek(storePath);
    assert.equal(first.isNew, true);
    assert.equal(first.kek.length, 32);
    assert.deepEqual(listApkgKeyIds(storePath), [first.keyId]);
    if (process.platform !== "win32") {
      // Windows（NTFS）不实现 POSIX 权限位——只在真实部署平台断言 0600。
      const mode = statSync(storePath).mode & 0o777;
      assert.equal(mode, 0o600, "key store must be 0600");
    }
    // 二次取同一 id：复用，不新建
    const again = getOrCreateApkgKek(storePath, first.keyId);
    assert.equal(again.isNew, false);
    assert.equal(again.kek.length, 32);
    assert.deepEqual(listApkgKeyIds(storePath), [first.keyId]);
    const direct = getApkgKek(storePath, first.keyId);
    assert.ok(direct, "getApkgKek finds the persisted generation");
  });
});

test("explicit missing keyId provisions that exact id; duplicate create is refused", async () => {
  await withStore(async (storePath) => {
    const { getOrCreateApkgKek, createApkgKeyGeneration } = await jiti.import("./apkg-keys.ts");
    const { keyId } = getOrCreateApkgKek(storePath, "k1");
    assert.equal(keyId, "k1");
    assert.throws(() => createApkgKeyGeneration(storePath, "k1"), /已存在/);
  });
});

test("keyId length limit (1..16) enforced on both paths", async () => {
  await withStore(async (storePath) => {
    const { getOrCreateApkgKek, createApkgKeyGeneration } = await jiti.import("./apkg-keys.ts");
    assert.throws(() => getOrCreateApkgKek(storePath, "x".repeat(17)), /1\.\.16/);
    assert.throws(() => createApkgKeyGeneration(storePath, ""), /1\.\.16/);
  });
});

test("getApkgKek never creates; store stays a plain id→base64 map", async () => {
  await withStore(async (storePath) => {
    const { getApkgKek, getOrCreateApkgKek } = await jiti.import("./apkg-keys.ts");
    assert.equal(getApkgKek(storePath, "nope"), undefined);
    const { keyId } = getOrCreateApkgKek(storePath);
    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    assert.equal(Object.keys(raw).length, 1);
    assert.equal(Buffer.from(raw[keyId], "base64").length, 32);
  });
});
