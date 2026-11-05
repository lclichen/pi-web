import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 流式文件响应已收敛到 lib/file-serve.ts（route 只做参数解析与分发）。
 * 断言共享响应头在全部响应形态（200/416/206）上生效。
 */
const source = await readFile(new URL("../../../lib/file-serve.ts", import.meta.url), "utf8");

test("streamed responses are not content-type sniffable", () => {
  assert.match(source, /"X-Content-Type-Options": "nosniff"/);
});

test("inline SVG is served with a script-blocking content security policy", () => {
  // SVG 是浏览器会作为文档执行的唯一内联预览类型，必须禁止脚本。
  assert.match(source, /contentType === "image\/svg\+xml"/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /style-src 'unsafe-inline'/);
  assert.match(source, /frame-ancestors 'self'/);
});

test("the restrictive headers are applied to every response shape", () => {
  const headerObject = source.indexOf("const headers");
  const firstStream = source.indexOf("createFileBodyStream", headerObject);
  assert.ok(headerObject !== -1 && firstStream > headerObject, "headers must be built before any response");
  // 全量 / 416（两种分支）/ 206 都展开共享 headers。
  assert.ok((source.match(/\.\.\.headers,/g) || []).length >= 3, "shared headers must be spread into 416/206 responses");
  assert.match(source, /status: 206/);
  assert.match(source, /status: 416/);
});
