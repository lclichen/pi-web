import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const mdSource = await readFile(new URL("./MarkdownBody.tsx", import.meta.url), "utf8");
const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("markdown images route through remotefs for remote-mode sessions", () => {
  // Context 声明 + 导出（ChatWindow 提供）。
  assert.match(mdSource, /export const RemoteFileSessionContext = createContext<string \| null>\(null\)/);
  // 图片 src 双分支：远端会话走 /api/remotefs?src=，否则服务端 /api/files。
  assert.match(
    mdSource,
    /remoteSessionId[\s\S]*?\/api\/remotefs\/\$\{encodeFilePathForApi\(filePath\)\}\?src=\$\{encodeURIComponent\(remoteSessionId\)\}/,
  );
  assert.match(mdSource, /\/api\/files\/\$\{encodeFilePathForApi\(filePath\)\}\?type=read/);
  // 消费 context。
  assert.match(mdSource, /useContext\(RemoteFileSessionContext\)/);
});

test("ChatWindow provides the context for sandbox/local-machine/ssh sessions", () => {
  assert.match(chatSource, /RemoteFileSessionContext/);
  assert.match(chatSource, /remoteFileSessionId\s+=\s+session\?\.id/);
  assert.match(chatSource, /mode === "sandbox" \|\| session\.mode === "local-machine" \|\| session\.mode === "ssh"/);
  // 历史消息与流式消息都在 Provider 内。
  const providers = (chatSource.match(/RemoteFileSessionContext\.Provider/g) ?? []).length;
  assert.ok(providers >= 2, `expected >=2 providers, got ${providers}`);
});
