import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_POLICY,
  evaluatePathAgainstPolicy,
  extractBashWriteTargets,
  mapToolPathToPolicy,
  parsePathScope,
  evaluateBashCommand,
} = await jiti.import("../pi-config/agent/extensions/amedac-core/src/path-guard-policy.ts");

const CWD = "/home/u/proj";
const NO_DECISIONS = { version: 1, entries: [] };

function policyWith(overrides = {}) {
  return { ...DEFAULT_POLICY, allowWrite: ["."], denyWrite: [], denyRead: [], ...overrides };
}

/**
 * v1 的 bash 提取只认 "./" "../" "/" "~/" 前缀，`rm .env`、`rm -rf secrets`
 * 这类裸相对名直接漏检——工作区内 denyWrite 形同虚设。以下用例锁定 v2 行为。
 */

test("bash: bare relative names are write targets (denyWrite is no longer bypassable)", () => {
  assert.deepEqual(extractBashWriteTargets("rm .env", CWD), [`${CWD}/.env`]);
  const policy = policyWith({ denyWrite: ["secrets/**"] });
  let scan = evaluateBashCommand("rm -rf secrets", CWD, policy, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
  assert.equal(scan.target, `${CWD}/secrets`);
  scan = evaluateBashCommand("mv secrets/a.txt /tmp/a.txt", CWD, policy, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
  scan = evaluateBashCommand("cp notes.md secrets/notes.md", CWD, policy, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
});

test("bash: redirections to deny-listed files are caught, device sinks are not", () => {
  const policy = policyWith({ denyWrite: [".env"] });
  assert.equal(evaluateBashCommand("echo SECRET=x > .env", CWD, policy, NO_DECISIONS).verdict.action, "deny");
  assert.equal(evaluateBashCommand("echo hello >>.env", CWD, policy, NO_DECISIONS).verdict.action, "deny");
  // 写日志到 /dev/null 不应触碰询问/拒绝。
  assert.equal(evaluateBashCommand("ls -la 2>/dev/null", CWD, policy, NO_DECISIONS).verdict.action, "allow");
  assert.equal(evaluateBashCommand("cmd > /dev/null 2>&1", CWD, policy, NO_DECISIONS).verdict.action, "allow");
  // 引号内的 > 不是重定向。
  assert.equal(extractBashWriteTargets(`echo "a > b"`, CWD).length, 0);
});

test("bash: cd tracking applies the right base inside one command string", () => {
  const outside = evaluateBashCommand("cd /tmp && rm -rf data", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(outside.verdict.action, "ask");
  assert.ok(outside.target?.startsWith("/tmp/data"));
  const inside = evaluateBashCommand("cd src && rm -rf generated", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(inside.verdict.action, "allow");
  const denied = evaluateBashCommand(
    "mkdir vendored && cd vendored && rm -f keep.me",
    CWD,
    policyWith({ denyWrite: ["vendored/**"] }),
    NO_DECISIONS,
  );
  assert.equal(denied.verdict.action, "deny");
});

test("bash: inline execution falls back to protected-name scanning", () => {
  const policy = policyWith({ denyWrite: [".env", "*.key"] });
  const py = evaluateBashCommand(`python3 -c "open('.env','w').write('x')"`, CWD, policy, NO_DECISIONS);
  assert.equal(py.verdict.action, "deny");
  const key = evaluateBashCommand("bash -c 'cat server.key > /tmp/k'", CWD, policy, NO_DECISIONS);
  // 读侧（denyRead 默认为空的自定义策略）不拦截，但 .key 写侧规则命中原文。
  assert.equal(key.verdict.action, "deny");
  // 普通只读命令不受内联扫描影响。
  assert.equal(evaluateBashCommand("grep -rn TODO src", CWD, policy, NO_DECISIONS).verdict.action, "allow");
});

test("read tool paths are evaluated against denyRead (previously ignored)", () => {
  const verdict = evaluatePathAgainstPolicy(`${CWD}/.env`, "read", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(verdict.action, "deny");
  assert.match(verdict.reason, /denyRead/);
  const grepDir = evaluatePathAgainstPolicy(`${CWD}/credentials`, "read", CWD, policyWith({ denyRead: ["credentials"] }), NO_DECISIONS);
  assert.equal(grepDir.action, "deny");
});

test("remote path space: /workspace maps to the project home before evaluation", () => {
  const scope = parsePathScope(JSON.stringify({ version: 1, mode: "sandbox", workspaceRoot: "/workspace" }));
  assert.deepEqual(scope, { version: 1, mode: "sandbox", workspaceRoot: "/workspace" });
  assert.equal(mapToolPathToPolicy("/workspace/src/a.ts", CWD, scope), `${CWD}/src/a.ts`);
  assert.equal(mapToolPathToPolicy("/workspace", CWD, scope), CWD);
  assert.equal(mapToolPathToPolicy("/etc/passwd", CWD, scope), "/etc/passwd");

  // 工作区内相对规则在远程模式同样生效。
  const policy = policyWith({ denyWrite: ["secrets/**"] });
  assert.equal(
    evaluatePathAgainstPolicy("/workspace/secrets/a.txt", "write", CWD, policy, NO_DECISIONS, scope).action,
    "deny",
  );
  // 默认凭据规则也命中远端 .env。
  assert.equal(
    evaluatePathAgainstPolicy("/workspace/.env", "read", CWD, DEFAULT_POLICY, NO_DECISIONS, scope).action,
    "deny",
  );
  // 工作区外的远端路径按"工作区外"处理。
  assert.equal(
    evaluatePathAgainstPolicy("/etc/passwd", "write", CWD, policy, NO_DECISIONS, scope).action,
    "ask",
  );
  // 自保护清单在远端路径空间同样有效（映射后才匹配）。
  assert.equal(
    evaluatePathAgainstPolicy("/workspace/.pi/path-policy.json", "write", CWD, policy, NO_DECISIONS, scope).action,
    "deny",
  );
});

test("remote path space: bash targets use the same mapping", () => {
  const scope = parsePathScope(JSON.stringify({ version: 1, mode: "ssh", workspaceRoot: "/srv/app" }));
  const policy = policyWith({ denyWrite: ["config/**"] });
  const scan = evaluateBashCommand("rm -rf config/prod", "/home/u/proj", policy, NO_DECISIONS, scope);
  assert.equal(scan.verdict.action, "deny");
  const outside = evaluateBashCommand("rm -rf /srv/other", "/home/u/proj", policy, NO_DECISIONS, scope);
  assert.equal(outside.verdict.action, "ask");
});

test("path scope parser rejects unusable roots", () => {
  assert.equal(parsePathScope(null), null);
  assert.equal(parsePathScope("garbage"), null);
  assert.equal(parsePathScope(JSON.stringify({ workspaceRoot: "/" })), null);
  assert.equal(parsePathScope(JSON.stringify({ workspaceRoot: "" })), null);
  assert.equal(parsePathScope(JSON.stringify({ mode: "weird", workspaceRoot: "/w" }))?.mode, "ssh");
});
