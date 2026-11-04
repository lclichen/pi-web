import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./config-cwd.ts", import.meta.url), "utf8");

test("config cwd resolver allows the caller's own quick workspaces", () => {
  // 快速会话工作区在首条消息前没有会话记录、也不是项目 home——
  // resolver 必须按用户归属放行，否则 /api/mcp、/api/agents、/api/plugins
  // 等对普通用户新建的快速会话一律 403“服务器目录仅管理员可用”。
  assert.match(source, /isCallerQuickWorkspace\(cwd, user\.id\)/);
  // 放行只扩大到“自己的” quick home，且仍要求登录（identity 在函数开头）。
  assert.match(source, /const identity = requireUserIdentity\(req\)/);
});
