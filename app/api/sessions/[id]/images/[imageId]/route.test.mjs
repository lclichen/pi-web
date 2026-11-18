import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("session image endpoint fences access and streams durable files", () => {
  assert.match(source, /resolveSessionAccess\(req, id, searchParams\)/);
  assert.match(source, /readSessionImage\(id, imageId\)/);
  assert.match(source, /Readable\.toWeb\(createReadStream/);
  assert.match(source, /Cache-Control.*immutable/);
  // The image store has no 10 MiB business cap; only the legacy inline parser does.
  assert.doesNotMatch(source, /MAX_TOOL_RESULT_IMAGE_BYTES|10 \* 1024/);
});
