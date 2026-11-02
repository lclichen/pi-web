import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// dataDir() 在每次调用时读 env；这里指向独立临时目录，避免污染真实 data/。
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "host-dirs-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  hostDirDisplayName,
  listHostDirs,
  normalizeHostRoot,
  removeHostDir,
  renameHostDir,
  upsertHostDir,
} = await jiti.import("./host-dirs.ts");

test("roots normalize and display names fall back to the basename", () => {
  assert.equal(normalizeHostRoot("/srv/app/"), "/srv/app");
  assert.equal(normalizeHostRoot("/"), "/");
  // Windows：保留会话 projectRoot 的反斜杠，否则空组和会话组会分裂
  assert.equal(normalizeHostRoot("D:\\Users\\me\\proj\\"), "D:\\Users\\me\\proj");
  assert.equal(normalizeHostRoot("C:\\"), "C:\\");
  assert.equal(hostDirDisplayName({ root: "/srv/app" }), "app");
  assert.equal(hostDirDisplayName({ root: "/srv/app", name: "  Demo  " }), "Demo");
});

test("upsert is idempotent per (owner, root) and keeps custom names", () => {
  const first = upsertHostDir({ ownerId: 1, root: "/srv/app/" });
  const again = upsertHostDir({ ownerId: 1, root: "/srv/app" });
  assert.equal(again.id, first.id);
  assert.equal(listHostDirs(1).length, 1);

  const named = upsertHostDir({ ownerId: 1, root: "/srv/app", name: "演示目录" });
  assert.equal(named.name, "演示目录");
  // 无 name 的重复 upsert 不清掉自定义名
  const keep = upsertHostDir({ ownerId: 1, root: "/srv/app" });
  assert.equal(keep.name, "演示目录");

  // 另一个 owner 的同名目录互不影响
  const other = upsertHostDir({ ownerId: 2, root: "/srv/app" });
  assert.notEqual(other.id, first.id);
  assert.equal(listHostDirs(2).length, 1);
  assert.equal(listHostDirs(1).length, 1);
});

test("rename clears the override on empty input; remove only deletes the record", () => {
  const record = upsertHostDir({ ownerId: 3, root: "/srv/rename-me" });
  const renamed = renameHostDir(record.id, 3, "新名字");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.dir.name, "新名字");
  const cleared = renameHostDir(record.id, 3, "   ");
  assert.equal(cleared.ok, true);
  assert.equal(cleared.dir.name, undefined);
  assert.equal(hostDirDisplayName(cleared.dir), "rename-me");

  // 跨 owner 的重命名/删除被拒绝
  assert.equal(renameHostDir(record.id, 99, "x").ok, false);
  assert.equal(removeHostDir(record.id, 99), false);
  assert.equal(removeHostDir(record.id, 3), true);
  assert.equal(listHostDirs(3).length, 0);
});
