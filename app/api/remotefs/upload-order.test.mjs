import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("chat uploads write the Host primary copy atomically before the remote mirror", () => {
  const host = source.indexOf("cacheHostCopy(name, bytes);");
  const remote = source.indexOf("await remoteWriteBytes(remote.ctx, target, bytes);");
  assert.notEqual(host, -1, "Host primary copy is written");
  assert.notEqual(remote, -1, "remote mirror is written");
  assert.ok(host < remote, "Host copy must be complete before the remote mirror starts");
  assert.match(source, /writeAttachmentAtomic\(hostDir, name, bytes\)/);
});
