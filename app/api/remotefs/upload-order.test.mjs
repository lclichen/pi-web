import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("chat uploads write the Host primary copy atomically before the remote mirror", () => {
  const host = source.indexOf("cacheHostCopy(name, bytes);");
  const remote = source.indexOf("await remoteWriteBytes(remote.ctx, target, bytes);");
  assert.notEqual(host, -1, "Host primary copy is written");
  assert.notEqual(remote, -1, "remote mirror is written");
  assert.ok(host < remote, "Host copy must be complete before the remote mirror starts");
  assert.match(source, /writeAttachmentAtomic\(hostDir, name, bytes\)/);
});

test("sanitizeUploadName strips NTFS-ADS colons and the client charset's invalid characters", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true, interopDefault: true });
  const { sanitizeUploadName } = await jiti.import("./[...path]/route.ts");
  // `file:stream` 构成 NTFS 备用数据流，落到 Host 附件区前必须洗掉；
  // 其余字符集对齐客户端 sanitizeAttachmentBase（lib/file-upload-client.ts）。
  assert.equal(sanitizeUploadName("report:v2.pdf"), "report v2.pdf");
  assert.equal(sanitizeUploadName('a<b>c?d*e"f|g.pdf'), "a b c d e f g.pdf");
  assert.equal(sanitizeUploadName("normal-file.txt"), "normal-file.txt");
  assert.equal(sanitizeUploadName("dir\\name.txt"), "name.txt");
  assert.equal(sanitizeUploadName(".."), null);
  assert.equal(sanitizeUploadName("."), null);
  assert.equal(sanitizeUploadName("   "), null);
});
