import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 保管文件落 dataDir——隔离到临时目录。
const dir = mkdtempSync(join(tmpdir(), "pi-web-key-vault-"));
const prevDataDir = process.env.PI_WEB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = dir;
test.after(() => {
  if (prevDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const v = await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./api-key-vault.ts"));

test("store → lookup → list roundtrip, per-user isolation", () => {
  v.vaultStoreApiKey(1, 101, "批量测试", "sk_aaa111");
  v.vaultStoreApiKey(1, 102, "第二把", "sk_bbb222");
  v.vaultStoreApiKey(2, 101, "别人的同 id", "sk_ccc333");
  assert.equal(v.vaultLookupApiKey(1, 101), "sk_aaa111");
  assert.equal(v.vaultLookupApiKey(1, 102), "sk_bbb222");
  assert.equal(v.vaultLookupApiKey(2, 101), "sk_ccc333");
  // 未知用户/id 返回 null（不抛）
  assert.equal(v.vaultLookupApiKey(3, 101), null);
  assert.equal(v.vaultLookupApiKey(1, 999), null);
  const list1 = v.vaultListApiKeys(1);
  assert.equal(list1.get("101"), "sk_aaa111");
  assert.equal(list1.get("102"), "sk_bbb222");
  assert.equal(list1.size, 2);
});

test("remove deletes only the targeted entry", () => {
  v.vaultStoreApiKey(1, 201, "x", "sk_x");
  v.vaultRemoveApiKey(1, 201);
  assert.equal(v.vaultLookupApiKey(1, 201), null);
  assert.equal(v.vaultLookupApiKey(1, 101), "sk_aaa111", "unrelated entry survives");
  // 重复删除静默
  v.vaultRemoveApiKey(1, 201);
});

test("vault file is 0600 private and JSON-shaped", () => {
  assert.ok(v.vaultExists());
  const file = join(dir, "api-key-vault.json");
  // 0600 只在 POSIX 可执行（Windows 的 chmod 只影响只读位）——Linux 部署
  // （VM/打包）上强制，Windows 开发环境跳过权限断言。
  if (process.platform !== "win32") {
    const st = statSync(file);
    assert.equal(st.mode & 0o777, 0o600, `file should be 0600, got ${(st.mode & 0o777).toString(8)}`);
  }
  assert.ok(existsSync(file));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.ok(parsed.users.u1["101"].key === "sk_aaa111");
});

test("re-store overwrites (same id, new plaintext)", () => {
  v.vaultStoreApiKey(1, 301, "r", "sk_old");
  v.vaultStoreApiKey(1, 301, "r2", "sk_new");
  assert.equal(v.vaultLookupApiKey(1, 301), "sk_new");
  v.vaultRemoveApiKey(1, 301);
});
