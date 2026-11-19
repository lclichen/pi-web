import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// host 模式（auth off）：身份是隐式 host 用户（id=0），桶根为 attachments/u0。
const SAVED_AUTH = process.env.PI_WEB_AUTH;
process.env.PI_WEB_AUTH = "off";
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "host-attachments-"));
after(() => {
  if (SAVED_AUTH === undefined) delete process.env.PI_WEB_AUTH;
  else process.env.PI_WEB_AUTH = SAVED_AUTH;
  rmSync(process.env.PI_WEB_DATA_DIR, { recursive: true, force: true });
  delete process.env.PI_WEB_DATA_DIR;
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET, DELETE } = await jiti.import("./route.ts");

const bucket = join(process.env.PI_WEB_DATA_DIR, "attachments", "u0");
mkdirSync(join(bucket, "session-1"), { recursive: true });
writeFileSync(join(bucket, "session-1", "a.txt"), "hello");

const request = (dir, method = "GET") =>
  new Request(`http://localhost/api/host/attachments?dir=${encodeURIComponent(dir)}`, {
    method,
    // 构造的 Request 不带 Host 头，API 安全检查需要一个。
    headers: { host: "localhost" },
  });

test("own no-project attachment bucket is measurable and cleanable", async () => {
  const before = await GET(request(bucket));
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { bytes: 5, files: 1, dir: bucket });

  const removed = await DELETE(request(bucket, "DELETE"));
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { bytes: 5, files: 1 });

  const after = await GET(request(bucket));
  assert.equal(after.status, 200);
  assert.deepEqual(await after.json(), { bytes: 0, files: 0, dir: bucket });
});

test("a directory that is not the caller's own bucket keeps the Host-dir semantics", async () => {
  // u42 不是本人的桶根（多用户模式下它也不在任何 file-access root 内），
  // 即便 host 模式的文件根覆盖了它，也只能按普通 Host 目录处理：
  // 清理目标是 <dir>/.pi/attachments，绝不能把 u42 整桶删掉。
  const other = join(process.env.PI_WEB_DATA_DIR, "attachments", "u42");
  mkdirSync(join(other, "session-9"), { recursive: true });
  writeFileSync(join(other, "session-9", "keep.txt"), "keep");

  const removed = await DELETE(request(other, "DELETE"));
  assert.ok(removed.ok, `expected success, got ${removed.status}`);
  assert.equal(existsSync(join(other, "session-9", "keep.txt")), true);
});
