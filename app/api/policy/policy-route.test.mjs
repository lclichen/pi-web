import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 设置 → 策略页后端（app/api/policy/route.ts）的源级契约测试
 *（仓库既有模式：app/api 测试断言路由源码结构，见 admin-routes.test.mjs）。
 * 判定函数本身的行为由 lib/path-guard*.test.mjs 覆盖；这里锁定：
 * 门禁顺序、试运行与护栏共用同一判定、写入规范化、锁定语义不被绕过。
 */

const src = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("every method gates on isApiRequestAllowed + requireUserIdentity before touching the project dir", () => {
  for (const method of ["GET", "PUT", "DELETE", "POST"]) {
    const fn = src.slice(src.indexOf(`export async function ${method}`));
    const body = fn.slice(0, fn.indexOf("\n}", fn.indexOf("resolveConfigCwdSync")));
    const gate = body.indexOf("requireUserIdentity(req)");
    const dir = body.indexOf("resolveConfigCwdSync");
    assert.ok(body.includes("isApiRequestAllowed(req)"), `${method}: API 请求门禁`);
    assert.ok(gate !== -1 && dir !== -1 && gate < dir, `${method}: 身份校验先于目录解析`);
  }
});

test("trial-run (POST) evaluates with the exact same functions as the guard extension", () => {
  // 判定函数来自共享 shim（amedac-core path-guard 源码的 re-export）。
  assert.match(src, /\} from "@\/lib\/extensions\/path-guard";/);
  assert.match(src, /evaluateBashCommand,\s*\r?\n\s*evaluatePathAgainstPolicy,/);
  // 试运行入口直接调用共享函数（与 amedac-core path-guard 同一份源码的 re-export shim）。
  assert.match(src, /evaluateBashCommand\(body\.command, dir\.cwd, policy, decisions, scope\)/);
  assert.match(src, /evaluatePathAgainstPolicy\(absPath, kind, dir\.cwd, policy, decisions, scope\)/);
  // 相对路径按会话 cwd 拼接，与护栏 resolveToolPath 的相对语义一致。
  assert.match(src, /\$\{dir\.cwd\}\/\$\{raw\}/);
});

test("PUT normalizes through parsePathPolicy before writing (garbage fields fall back, not persisted raw)", () => {
  const put = src.slice(src.indexOf("export async function PUT"), src.indexOf("export async function DELETE"));
  assert.match(put, /const normalized: PathPolicy = parsePathPolicy\(serialized\)/);
  assert.match(put, /writeFileSync\(target, JSON\.stringify\(normalized/);
});

test("PUT enforces the edit lock before any write; DELETE requires an absolute decision path", () => {
  const put = src.slice(src.indexOf("export async function PUT"), src.indexOf("export async function DELETE"));
  assert.ok(put.indexOf("resolveEditable") < put.indexOf("writeFileSync"), "锁检查先于写盘");
  assert.match(put, /lockReason === "not-admin"/, "非管理员给出明确锁定文案");

  const del = src.slice(src.indexOf("export async function DELETE"));
  assert.match(del, /const isAbsolute =/, "DELETE 只接受绝对路径（含 Windows 盘符）");
});

test("GET exposes lock state so the UI can render read-only policy for non-admin users", () => {
  const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function PUT"));
  assert.match(get, /resolveEditable\(dir\.cwd/);
  assert.match(get, /\.\.\.\(lockReason \? \{ lockReason \} : \{\}\)/);
});
