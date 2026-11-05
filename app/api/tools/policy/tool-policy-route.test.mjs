import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 工具护栏视图 API（GET /api/tools/policy）的源级契约测试
 *（仓库既有模式：app/api 测试断言路由源码结构）。
 * 判定逻辑本身由 lib/tool-policy.test.mjs / tool-policy-clamp.test.mjs 覆盖；
 * 这里锁定门禁顺序与"与装配层共用同一套判定函数"这一事实。
 */

const src = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("gates on isApiRequestAllowed + requireUserIdentity before resolving the project dir", () => {
  assert.ok(src.includes("isApiRequestAllowed(req)"));
  const gate = src.indexOf("requireUserIdentity(req)");
  const dir = src.indexOf("resolveConfigCwdSync(");
  assert.ok(gate !== -1 && dir !== -1 && gate < dir, "身份校验先于目录解析");
});

test("uses the same policy functions as the session assembly (single source of truth)", () => {
  assert.match(src, /import \{ isRemoteMode, mcpServerModePolicy \} from "@\/lib\/tool-policy"/);
  assert.match(src, /mcpServerModePolicy\(server\.entry, server\.transport, mode\)/);
  assert.match(src, /import \{ TOOL_MANIFEST \} from "@\/lib\/extensions\/tool-manifest"/);
});

test("project mode comes from the project registry; unknown cwd falls back to host", () => {
  assert.match(src, /listProjects\(ownerId\)/);
  assert.match(src, /projectHome\(project\)/);
  assert.match(src, /return "host";/);
});

test("MCP servers are read with the requester's user scope (per-user layer included)", () => {
  assert.match(src, /readMcpConfig\(dir\.cwd, \{ userId: ownerId \}\)/);
  assert.match(src, /server\.entry\.piWeb \?\? null/);
});
