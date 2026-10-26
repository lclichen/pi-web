import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_POLICY,
  SELF_PROTECTED_PATTERNS,
  evaluatePathAgainstPolicy,
  extractBashWriteTargets,
  matchesPattern,
  parsePathPolicy,
  parsePolicyDecisions,
} = await jiti.import("../pi-config/agent/extensions/amedac-core/src/path-guard-policy.ts");

const CWD = "/home/u/proj";

test("glob matcher: workspace-relative patterns, ** depth, dir coverage", () => {
  assert.equal(matchesPattern(".", "/home/u/proj/src/a.ts", CWD), true);
  assert.equal(matchesPattern("src", "/home/u/proj/src/a.ts", CWD), true); // 目录模式覆盖其下内容
  assert.equal(matchesPattern("src/**", "/home/u/proj/src/x/y.ts", CWD), true);
  assert.equal(matchesPattern("src/*.ts", "/home/u/proj/src/a.ts", CWD), true);
  assert.equal(matchesPattern("src/*.ts", "/home/u/proj/src/x/a.ts", CWD), false); // * 不跨段
  assert.equal(matchesPattern(".env.*", "/home/u/proj/.env.local", CWD), true);
  assert.equal(matchesPattern(".", "/etc/passwd", CWD), false);
  assert.equal(matchesPattern("/tmp/out", "/tmp/out/x", "/"), true); // 绝对模式
});

test("evaluation order: self-protection → deny → decision → allow → outside-ask", () => {
  const policy = { ...DEFAULT_POLICY, allowWrite: ["."], denyWrite: ["build"] };
  const noDecisions = { version: 1, entries: [] };

  // 1) 自保护恒拒绝
  let v = evaluatePathAgainstPolicy(`${CWD}/.pi/path-policy.json`, "write", CWD, policy, noDecisions);
  assert.equal(v.action, "deny");
  v = evaluatePathAgainstPolicy(`${CWD}/.pi/sessions/abc.jsonl`, "write", CWD, policy, noDecisions);
  assert.equal(v.action, "deny");

  // 2) deny 规则
  v = evaluatePathAgainstPolicy(`${CWD}/build/out.js`, "write", CWD, policy, noDecisions);
  assert.equal(v.action, "deny");

  // 3) 持久决策优先于 allow/ask
  const decisions = { version: 1, entries: [{ path: "/srv/data", decision: "allow", at: 1 }] };
  v = evaluatePathAgainstPolicy("/srv/data/x", "write", CWD, policy, decisions);
  assert.equal(v.action, "allow");
  const denyDecisions = { version: 1, entries: [{ path: "/srv/data", decision: "deny", at: 1 }] };
  v = evaluatePathAgainstPolicy("/srv/data/x", "write", CWD, policy, denyDecisions);
  assert.equal(v.action, "deny");

  // 4) 工作区内 allow；工作区外 ask（默认）
  v = evaluatePathAgainstPolicy(`${CWD}/src/a.ts`, "write", CWD, policy, noDecisions);
  assert.equal(v.action, "allow");
  v = evaluatePathAgainstPolicy("/srv/data/x", "write", CWD, policy, noDecisions);
  assert.equal(v.action, "ask");

  // 5) askOnOutsideWrite=false → 区外直接拒绝；读默认放行（仅 deny 清单拦）
  const strict = { ...policy, askOnOutsideWrite: false };
  assert.equal(evaluatePathAgainstPolicy("/srv/data/x", "write", CWD, strict, noDecisions).action, "deny");
  assert.equal(evaluatePathAgainstPolicy("/srv/other", "read", CWD, policy, noDecisions).action, "allow");
  assert.equal(evaluatePathAgainstPolicy(`${CWD}/.env`, "read", CWD, policy, noDecisions).action, "deny");
});

test("policy parsing: defaults on absent, hardened on garbage, explicit file wins", () => {
  const d = parsePathPolicy(null);
  assert.deepEqual(d.allowWrite, ["."]);
  const g = parsePathPolicy("not json{{{");
  assert.equal(g.version, 1);
  const custom = parsePathPolicy(JSON.stringify({ allowWrite: ["/srv/out"], denyWrite: [], denyRead: [], askOnOutsideWrite: false }));
  assert.deepEqual(custom.allowWrite, ["/srv/out"]);
  assert.equal(custom.askOnOutsideWrite, false);
  const emptyAllow = parsePathPolicy(JSON.stringify({ allowWrite: [] }));
  assert.deepEqual(emptyAllow.allowWrite, ["."], "空 allowWrite 回默认（不允许全锁死写入）");
  assert.deepEqual(parsePolicyDecisions('{"entries":[{"path":"/a","decision":"deny","at":5}]}').entries, [{ path: "/a", decision: "deny", at: 5 }]);
  assert.deepEqual(parsePolicyDecisions("garbage").entries, []);
});

test("bash write-target extraction: redirects + destructive commands, cwd-relative resolution", () => {
  const t1 = extractBashWriteTargets("echo hi > /tmp/out.log", CWD);
  assert.deepEqual(t1, ["/tmp/out.log"]);
  const t2 = extractBashWriteTargets("python x.py >> ./results/r.txt 2>&1", CWD);
  assert.ok(t2.includes(`${CWD}/results/r.txt`));
  const t3 = extractBashWriteTargets("rm -rf /srv/data", CWD);
  assert.deepEqual(t3, ["/srv/data"]);
  const t4 = extractBashWriteTargets("grep foo bar.txt", CWD);
  assert.deepEqual(t4, [], "只读命令不产生写入目标");
  const t5 = extractBashWriteTargets("cp src/a.ts ../backup/a.ts", CWD);
  assert.ok(t5.includes(`${CWD}/../backup/a.ts`) || t5.some((p) => p.endsWith("backup/a.ts")));
});

test("self-protected list is exported and covers policy files + runtime dirs", () => {
  assert.ok(SELF_PROTECTED_PATTERNS.includes(".pi/path-policy.json"));
  assert.ok(SELF_PROTECTED_PATTERNS.includes(".pi/path-policy.decisions.json"));
  assert.ok(SELF_PROTECTED_PATTERNS.includes(".pi/auth.json"));
});
