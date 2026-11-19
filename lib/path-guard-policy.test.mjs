import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_POLICY,
  SELF_PROTECTED_PATTERNS,
  evaluateBashCommand,
  evaluatePathAgainstPolicy,
  extractBashWriteTargets,
  isAbsolutePolicyPath,
  isWindowsDriveAbsolute,
  mapToolPathToPolicy,
  matchesPattern,
  normalizePolicyPath,
  parsePathPolicy,
  parsePolicyDecisions,
  parsePathScope,
  samePolicyPath,
} = await jiti.import("../pi-config/agent/extensions/amedac-core/src/path-guard-policy.ts");

const CWD = "/home/u/proj";
const WIN_CWD = "C:/proj";

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
  const custom = parsePathPolicy(
    JSON.stringify({ allowWrite: ["/srv/out"], denyWrite: [], denyRead: [], askOnOutsideWrite: false }),
  );
  assert.deepEqual(custom.allowWrite, ["/srv/out"]);
  assert.equal(custom.askOnOutsideWrite, false);
  const emptyAllow = parsePathPolicy(JSON.stringify({ allowWrite: [] }));
  assert.deepEqual(emptyAllow.allowWrite, ["."], "空 allowWrite 回默认（不允许全锁死写入）");
  assert.deepEqual(parsePolicyDecisions('{"entries":[{"path":"/a","decision":"deny","at":5}]}').entries, [
    { path: "/a", decision: "deny", at: 5 },
  ]);
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

// ---------------------------------------------------------------------------
// Windows 路径护栏（审查 F1）：盘符大小写折叠、UNC 按绝对路径处理、
// POSIX 大小写敏感语义不变。端到端的“不再询问”场景在 path-guard.test.mjs。

test("F1c helpers: isAbsolutePolicyPath / isWindowsDriveAbsolute classify absolute forms", () => {
  for (const abs of ["/x", "~/x", "C:/x", "c:\\x", "\\\\host\\share", "//host/share"]) {
    assert.equal(isAbsolutePolicyPath(abs), true, abs);
  }
  for (const rel of ["src/a", "./a", "C:work", "host/share"]) {
    assert.equal(isAbsolutePolicyPath(rel), false, rel);
  }
  assert.equal(isWindowsDriveAbsolute("C:/"), true);
  assert.equal(isWindowsDriveAbsolute("c:\\"), true);
  assert.equal(isWindowsDriveAbsolute("C:work"), false, "盘符相对路径（无分隔符）不算绝对");
  assert.equal(isWindowsDriveAbsolute("1:/x"), false);
});

test("F1a drive-letter decisions match case-insensitively (C:\\work 落盘 → c:\\WORK\\x 命中)", () => {
  const decisions = parsePolicyDecisions(
    JSON.stringify({ version: 1, entries: [{ path: "C:\\work", decision: "deny", at: 1 }] }),
  );
  assert.equal(decisions.entries[0].path, "C:/work", "落盘归一为正斜杠形态");
  const hit = evaluatePathAgainstPolicy("c:\\WORK\\x", "write", WIN_CWD, DEFAULT_POLICY, decisions);
  assert.equal(hit.action, "deny", "大小写不同的工具路径必须命中持久决策");
  assert.match(hit.reason, /不再询问/);
  // 反证：没有决策时同一位置是 ask——deny 确实来自决策命中，而非默认策略。
  const miss = evaluatePathAgainstPolicy("c:\\WORK\\x", "write", WIN_CWD, DEFAULT_POLICY, { version: 1, entries: [] });
  assert.equal(miss.action, "ask");
});

test("F1a drive-letter policy globs fold case on either side", () => {
  const policy = { ...DEFAULT_POLICY, allowWrite: ["."], denyWrite: ["c:\\work\\secret.*"], denyRead: [] };
  assert.equal(
    evaluatePathAgainstPolicy("C:/WORK/secret.pem", "write", WIN_CWD, policy, { version: 1, entries: [] }).action,
    "deny",
  );
});

test("F1a samePolicyPath folds Windows forms (兼容已落盘的旧大小写决策 key)", () => {
  assert.equal(samePolicyPath("C:/work", "c:/WORK"), true);
  assert.equal(samePolicyPath("C:/work/x", "c:/work/X"), true);
  assert.equal(samePolicyPath("//host/share/f", "\\\\HOST\\Share\\f"), true);
  assert.equal(samePolicyPath("//host/share", "/host/share"), false, "UNC 与单斜杠根路径是不同命名空间");
  assert.equal(samePolicyPath("C:/work", "/c/work"), false);
});

test("F1b UNC paths normalize to //host/share and stay absolute (never joined under cwd)", () => {
  assert.equal(normalizePolicyPath("\\\\host\\share\\f"), "//host/share/f");
  assert.equal(normalizePolicyPath("//HOST//Share/f"), "//HOST/Share/f");
  // 正斜杠 UNC 直接可提取；反斜杠形态在 bash 分词里是转义符，需引号包裹
  // 才保留段结构（与盘符路径同一既有约定，见 destructiveOperands 注释）。
  assert.deepEqual(extractBashWriteTargets("rm -rf //host/share/x", WIN_CWD), ["//host/share/x"]);
  assert.deepEqual(extractBashWriteTargets("rm -rf '\\\\host\\share\\x'", WIN_CWD), ["//host/share/x"]);
  // 回归：普通相对目标仍按 cwd 拼，不会被误判成 UNC。
  assert.deepEqual(extractBashWriteTargets("rm -rf build", CWD), ["/home/u/proj/build"]);
});

test("F1b UNC decisions/policy treat \\\\host\\share\\f and //host/share/f (any case) as equivalent", () => {
  const noDecisions = { version: 1, entries: [] };
  const decisions = parsePolicyDecisions(
    JSON.stringify({ version: 1, entries: [{ path: "\\\\host\\share\\f", decision: "deny", at: 1 }] }),
  );
  assert.equal(decisions.entries[0].path, "//host/share/f", "UNC 决策归一保留双斜杠");
  assert.equal(
    evaluatePathAgainstPolicy("//host/share/f/inner.txt", "write", WIN_CWD, DEFAULT_POLICY, decisions).action,
    "deny",
    "决策目录覆盖子树：正斜杠 UNC 命中",
  );
  assert.equal(
    evaluatePathAgainstPolicy("\\\\HOST\\Share\\f", "write", WIN_CWD, DEFAULT_POLICY, decisions).action,
    "deny",
    "主机名/共享名大小写不敏感",
  );
  // 反证：无决策 → 工作区外 ask。
  assert.equal(
    evaluatePathAgainstPolicy("\\\\host\\share\\f", "write", WIN_CWD, DEFAULT_POLICY, noDecisions).action,
    "ask",
  );
  // 策略侧：denyWrite 反斜杠形态、路径侧正斜杠，同样命中（若被拼到 cwd 下则不会 deny）。
  const policy = { ...DEFAULT_POLICY, allowWrite: ["."], denyWrite: ["\\\\host\\share\\f"], denyRead: [] };
  assert.equal(evaluatePathAgainstPolicy("//host/share/f", "write", WIN_CWD, policy, noDecisions).action, "deny");
  assert.equal(evaluateBashCommand("rm -rf //host/share/f", WIN_CWD, policy, noDecisions).verdict.action, "deny");
});

test("F1b UNC scope roots map remote workspace paths case-insensitively", () => {
  const scope = parsePathScope(JSON.stringify({ version: 1, mode: "local-machine", workspaceRoot: "//Host/Share" }));
  assert.ok(scope, "UNC 远端根可用");
  assert.equal(mapToolPathToPolicy("\\\\host\\share\\src\\a.ts", CWD, scope), `${CWD}/src/a.ts`);
  assert.equal(mapToolPathToPolicy("//host/share", CWD, scope), CWD, "根本身映射为 cwd");
  assert.equal(mapToolPathToPolicy("//other/share/x", CWD, scope), "//other/share/x", "区外原样保留");
});

test("F1a POSIX semantics stay case-sensitive (/a/B ≠ /a/b)", () => {
  assert.equal(matchesPattern("/a/B", "/a/b", CWD), false);
  assert.equal(matchesPattern("/a/B", "/a/B", CWD), true);
  const decisions = { version: 1, entries: [{ path: "/a/B", decision: "deny", at: 1 }] };
  assert.equal(evaluatePathAgainstPolicy("/a/b", "write", CWD, DEFAULT_POLICY, decisions).action, "ask");
  assert.equal(evaluatePathAgainstPolicy("/a/B", "write", CWD, DEFAULT_POLICY, decisions).action, "deny");
  assert.equal(samePolicyPath("/a/B", "/a/b"), false);
});

test("F1b regression: relative decision entries still anchor at filesystem root (no accidental // prefix)", () => {
  const decisions = { version: 1, entries: [{ path: "src", decision: "deny", at: 1 }] };
  assert.equal(evaluatePathAgainstPolicy("/src/x", "write", CWD, DEFAULT_POLICY, decisions).action, "deny");
});
