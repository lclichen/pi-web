import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("worktrees gate derives roots from the request identity with an ownership fallback", () => {
  // 旧实现用 host 空间 getAllowedFileRoots()：普通用户的项目 home 与快速
  // 工作区都不在里面 → 一律 403。现在按请求身份取根 + 会话 cwd，再按归属
  // （自己的项目 home / quick home）兜底，语义与 /api/files、project-trust 一致。
  assert.match(source, /allowedRootsWithSessionCwds\(req, await getAllowedFileRootsForRequest\(req\)\)/);
  assert.match(source, /isCallerOwnedProjectHome\(cwd, user\.id, false\)/);
  assert.match(source, /isCallerQuickWorkspace\(cwd, user\.id\)/);
  // 三个动词共用同一道门。
  assert.equal((source.match(/checkCwdAllowed\(req, /g) ?? []).length, 3);
});
