import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * @ 文件引用菜单的取数链路。客户端无法直连远程工作区，全部走服务端：
 *   · host 会话   → GET /api/file-index?cwd=<服务器目录>
 *   · 远程会话    → GET /api/remotefs/?src=<sid>&type=search&q=<query>
 * 两端必须同时工作，否则菜单为空（用户实测 host 与远程都空）。
 */

test("file-index uses the same session-cwd fence as /api/files", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /allowedRootsWithSessionCwds\(req, await getAllowedFileRootsForRequest\(req\)\)/);
  assert.doesNotMatch(source, /getAllowedFileRoots\(\);/);
});

test("ChatInput routes remote @ queries through remotefs search", async () => {
  const source = await readFile(new URL("../../../components/ChatInput.tsx", import.meta.url), "utf8");
  // Remote sessions: query the remotefs bridge with the virtual root.
  assert.match(source, /remoteFileSessionId\s*\?/);
  assert.match(source, /type=search&q=\$\{encodeURIComponent\(query\)\}/);
  // Remote sessions never use the (empty stub-home) file index.
  assert.match(source, /if \(remoteFileSessionId\) \{[\s\S]{0,80}setFileIndex\(/);
});

test("ChatWindow passes the remote session id to ChatInput", async () => {
  const source = await readFile(new URL("../../../components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /remoteFileSessionId=\{remoteFileSessionId\}/);
});
