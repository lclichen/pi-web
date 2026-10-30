import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sliceByteRange } = await jiti.import("./http-range.ts");
const { getPreviewMime } = await jiti.import("./file-types.ts");

/**
 * 远程文件面板的媒体预览。旧实现把图片也走 JSON 文本读取（`{content}`
 * ——非法 UTF-8 会被替换成 U+FFFD），所以远程图片/视频只能看到 JSON。
 * 现在：媒体类交给 remoteReadBinary 原样返回字节 + content-type（含单段
 * Range），文本仍走 JSON。这里锁定 mime 判定、Range 切片与路由分支。
 */

test("media extensions map to a preview mime; text/code stays null", () => {
  assert.equal(getPreviewMime("/w/pic.png"), "image/png");
  assert.equal(getPreviewMime("/w/a.JPEG"), "image/jpeg");
  assert.equal(getPreviewMime("/w/clip.mp4"), "video/mp4");
  assert.equal(getPreviewMime("/w/voice.mp3"), "audio/mpeg");
  assert.equal(getPreviewMime("/w/doc.pdf"), "application/pdf");
  assert.equal(getPreviewMime("/w/readme.md"), null);
  assert.equal(getPreviewMime("/w/main.ts"), null);
});

test("sliceByteRange handles open/suffix/closed ranges and rejects junk", () => {
  const bytes = Buffer.from("0123456789", "utf8");
  assert.deepEqual(sliceByteRange(bytes, "bytes=2-5"), {
    body: Buffer.from("2345"),
    contentRange: "bytes 2-5/10",
  });
  assert.deepEqual(sliceByteRange(bytes, "bytes=7-"), {
    body: Buffer.from("789"),
    contentRange: "bytes 7-9/10",
  });
  assert.deepEqual(sliceByteRange(bytes, "bytes=-3"), {
    body: Buffer.from("789"),
    contentRange: "bytes 7-9/10",
  });
  // Whole-body fallbacks: no header, multi-range, unsatisfiable, oversized end.
  assert.equal(sliceByteRange(bytes, null), null);
  assert.equal(sliceByteRange(bytes, "bytes=0-1,4-5"), null);
  assert.equal(sliceByteRange(bytes, "bytes=99-100"), null);
  assert.equal(sliceByteRange(bytes, "items=0-1"), null);
  assert.deepEqual(sliceByteRange(bytes, "bytes=0-99"), {
    body: bytes,
    contentRange: "bytes 0-9/10",
  });
});

test("remotefs serves media as raw bytes; text keeps the JSON shape", async () => {
  const source = await readFile(new URL("../app/api/remotefs/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(source, /const mime = getPreviewMime\(filePath\)/);
  assert.match(source, /await remoteReadBinary\(remote\.ctx, filePath\)/);
  assert.match(source, /"Content-Type": mime/);
  assert.match(source, /sliceByteRange\(bytes, req\.headers\.get\("range"\)\)/);
  // The text fallback must still return { content, language, size }.
  assert.match(source, /return NextResponse\.json\(\{ content, language: detectFileLanguage\(filePath\), size \}\)/);
});
