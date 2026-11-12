import assert from "node:assert/strict";
import test from "node:test";
import { remoteBytesResponse, shouldServeRemoteBytes } from "./remote-file-response.ts";

const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x00]);

test("remote downloads always serve raw bytes", () => {
  assert.equal(shouldServeRemoteBytes("download", "/tmp/archive.zip"), true);
  assert.equal(shouldServeRemoteBytes("download", "/tmp/notes.txt"), true);
  assert.equal(shouldServeRemoteBytes("download", "/tmp/photo.png"), true);
});

test("remote reads stream bytes only for previewable media/documents", () => {
  assert.equal(shouldServeRemoteBytes("read", "/tmp/photo.png"), true);
  assert.equal(shouldServeRemoteBytes("read", "/tmp/report.pdf"), true);
  assert.equal(shouldServeRemoteBytes("read", "/tmp/archive.zip"), false);
  assert.equal(shouldServeRemoteBytes("read", "/tmp/notes.txt"), false);
});

test("zip downloads return the original bytes, not decoded text", async () => {
  const res = remoteBytesResponse("download", "/tmp/archive.zip", zipBytes, null);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), zipBytes);
});

test("preview reads keep their media type without attachment disposition", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const res = remoteBytesResponse("read", "/tmp/photo.png", png, null);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("content-disposition"), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
});

test("downloads keep single-range support", async () => {
  const res = remoteBytesResponse("download", "/tmp/archive.zip", zipBytes, "bytes=1-3");
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 1-3/${zipBytes.length}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), zipBytes.subarray(1, 4));
});
