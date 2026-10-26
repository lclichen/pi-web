import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("no-cwd model requests are deployment defaults — no per-user root fence", () => {
  // 无显式 cwd（快速会话选择后、会话未建立）此前回落 process.cwd() 并走
  // 文件根归属检查——非管理员必 403 "Access denied"（模型错误/无权限/
  // 未配置默认模型）。现在显式 cwd / projectId 才做 stat + roots 检查。
  assert.match(source, /const explicitCwd = new URL\(req\.url\)\.searchParams\.get\("cwd"\)/);
  assert.match(source, /if \(explicitCwd \|\| projectId\) \{/);
  // 显式路径仍走完整检查（stat + roots + 项目/会话兜底）。
  const fenced = source.slice(source.indexOf("if (explicitCwd || projectId)"));
  assert.match(fenced, /isCallerOwnedProjectHome/);
  assert.match(fenced, /isCallerSessionCwdAllowed/);
  assert.match(fenced, /status: 403/);
});
