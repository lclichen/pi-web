import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// mode-homes 在调用时创建 dataDir；独立目录，别碰真实部署数据。
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "mode-homes-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { quickHomeDir, isCallerQuickWorkspace } = await jiti.import("./mode-homes.ts");

/**
 * isCallerQuickWorkspace 是“快速会话工作区归属”判定的唯一事实源：
 * 普通用户新建快速会话（未发消息、无会话记录、非项目 home）时，
 * 配置/模型/信任/Git 接口靠它放行 quick-homes/u<id>/q-* 目录。
 */
test("accepts the caller's own quick home subtree only", () => {
  const ws = join(quickHomeDir(7), "q-default-ab12cd34");
  assert.equal(isCallerQuickWorkspace(ws, 7), true);
  assert.equal(isCallerQuickWorkspace(join(quickHomeDir(7), "nested", "deeper"), 7), true);
  // home 本身也算（无模板时的共享兜底目录）
  assert.equal(isCallerQuickWorkspace(quickHomeDir(7), 7), true);
});

test("rejects other users' homes, outside paths and anonymous callers", () => {
  const ws = join(quickHomeDir(7), "q-default-ab12cd34");
  assert.equal(isCallerQuickWorkspace(join(quickHomeDir(8), "q-x"), 7), false, "another user's home");
  assert.equal(isCallerQuickWorkspace(join(quickHomeDir(7), "..", "u8", "q-x"), 7), false, "path traversal");
  assert.equal(isCallerQuickWorkspace("/etc", 7), false, "outside the data dir");
  assert.equal(isCallerQuickWorkspace(ws, 0), false, "anonymous/implicit-host id has no quick home");
  assert.equal(isCallerQuickWorkspace(ws, -1), false);
});
