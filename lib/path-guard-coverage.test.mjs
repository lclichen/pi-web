import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_POLICY,
  SELF_PROTECTED_PATTERNS,
  bashUsesInlineExecution,
  evaluateBashCommand,
  evaluatePathAgainstPolicy,
  extractBashWriteTargets,
  mapToolPathToPolicy,
  normalizePolicyPath,
  parsePathScope,
} = await jiti.import("../pi-config/agent/extensions/amedac-core/src/path-guard-policy.ts");

const CWD = "/home/u/proj";
const NO_DECISIONS = { version: 1, entries: [] };

function policyWith(overrides = {}) {
  return { ...DEFAULT_POLICY, allowWrite: ["."], denyWrite: [], denyRead: [], ...overrides };
}

/**
 * docs/dev/path-policy-guardrails.md 第 5 节声称的解析分支补测：
 * PowerShell cmdlet、sed -i、dd of=、find -delete、git 系、-t 目标目录、
 * install -m、pushd、重定向变体、命令前缀跳过、内联执行全部触发形态。
 * 这些是 commit 86e71378 的新增解析分支，回归即静默失效。
 */

// ---------------------------------------------------------------------------
// PowerShell cmdlet（WRITE_COMMANDS 里的 9 个 cmdlet 走同一提取管线）

test("powershell: write cmdlets contribute their operands as write targets", () => {
  assert.deepEqual(extractBashWriteTargets("remove-item -recurse secrets", CWD), [`${CWD}/secrets`]);
  assert.deepEqual(extractBashWriteTargets("move-item a.txt /tmp/b.txt", CWD), [`${CWD}/a.txt`, "/tmp/b.txt"]);
  assert.deepEqual(extractBashWriteTargets("copy-item src dst", CWD), [`${CWD}/src`, `${CWD}/dst`]);
  assert.deepEqual(extractBashWriteTargets("new-item out.log", CWD), [`${CWD}/out.log`]);
  assert.ok(extractBashWriteTargets("set-content .env x", CWD).includes(`${CWD}/.env`));
  assert.deepEqual(extractBashWriteTargets("clear-content log.txt", CWD), [`${CWD}/log.txt`]);
  assert.deepEqual(extractBashWriteTargets("out-file o.txt", CWD), [`${CWD}/o.txt`]);
  assert.deepEqual(extractBashWriteTargets("rename-item old.txt new.txt", CWD), [`${CWD}/old.txt`, `${CWD}/new.txt`]);
  // 评估侧：默认 denyWrite 的 .env 被 cmdlet 形式命中。
  const scan = evaluateBashCommand("remove-item -recurse .env", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
  assert.equal(scan.target, `${CWD}/.env`);
});

test("powershell: set-location switches the relative base inside one command string", () => {
  const targets = extractBashWriteTargets("set-location /tmp; remove-item x", CWD);
  assert.deepEqual(targets, ["/tmp/x"]);
  const scan = evaluateBashCommand("set-location /tmp; remove-item x", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(scan.verdict.action, "ask", "cd 后的相对目标按新基准判为工作区外");
});

// ---------------------------------------------------------------------------
// sed / dd / find / git 的专用分支

test("sed: -i targets files after the expression; plain sed is read-only", () => {
  assert.deepEqual(extractBashWriteTargets("sed -i 's/a/b/' .env", CWD), [`${CWD}/.env`]);
  assert.deepEqual(extractBashWriteTargets("sed 's/a/b/' .env", CWD), [], "无 -i 不算写");
  const scan = evaluateBashCommand("sed -i 's/a/b/' .env", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
});

test("dd: of= is the write target, if= is not", () => {
  assert.deepEqual(extractBashWriteTargets("dd if=boot.img of=.env", CWD), [`${CWD}/.env`]);
  assert.deepEqual(extractBashWriteTargets("dd of=/dev/sda if=x", CWD), ["/dev/sda"]);
  const scan = evaluateBashCommand("dd if=boot.img of=.env", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
});

test("find: -delete makes roots write targets; without it find is read-only", () => {
  assert.deepEqual(extractBashWriteTargets("find secrets -name '*.log' -delete", CWD), [`${CWD}/secrets`]);
  assert.deepEqual(extractBashWriteTargets("find . -name x", CWD), []);
  const scan = evaluateBashCommand(
    "find secrets -delete",
    CWD,
    policyWith({ denyWrite: ["secrets/**"] }),
    NO_DECISIONS,
  );
  assert.equal(scan.verdict.action, "deny");
});

test("git: -C dir is a write target for clean/reset/checkout/rm; plain status is read-only", () => {
  assert.deepEqual(extractBashWriteTargets("git -C secrets clean -fdx", CWD), [`${CWD}/secrets`]);
  assert.deepEqual(extractBashWriteTargets("git checkout -- file.txt", CWD), [CWD]);
  assert.deepEqual(extractBashWriteTargets("git status", CWD), []);
  const denied = evaluateBashCommand(
    "git -C secrets clean -fdx",
    CWD,
    policyWith({ denyWrite: ["secrets/**"] }),
    NO_DECISIONS,
  );
  assert.equal(denied.verdict.action, "deny");
  const outside = evaluateBashCommand("git -C /srv status", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(outside.verdict.action, "ask", "-C 工作区外目录也要过闸");
});

// ---------------------------------------------------------------------------
// flag 语义：-t 目标目录、install -m 的取值跳过

test("cp/mv -t and --target-directory: the target directory counts as an operand", () => {
  const denied = evaluateBashCommand("mv -t secrets a.txt", CWD, policyWith({ denyWrite: ["secrets/**"] }), NO_DECISIONS);
  assert.equal(denied.verdict.action, "deny");
  const long = evaluateBashCommand(
    "cp --target-directory secrets a.txt",
    CWD,
    policyWith({ denyWrite: ["secrets/**"] }),
    NO_DECISIONS,
  );
  assert.equal(long.verdict.action, "deny");
  const outside = evaluateBashCommand("cp -t /tmp a.txt", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(outside.verdict.action, "ask");
});

test("install -m 644: the mode value is skipped, file operands still checked", () => {
  const scan = evaluateBashCommand("install -m 644 src .env", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
  assert.equal(scan.target, `${CWD}/.env`);
});

// ---------------------------------------------------------------------------
// cd 基准：pushd 与 cd 同权重定位

test("pushd updates the relative base like cd does", () => {
  const targets = extractBashWriteTargets("pushd /tmp && rm x", CWD);
  assert.deepEqual(targets, ["/tmp/x"]);
  const inside = evaluateBashCommand("pushd src && rm generated", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(inside.verdict.action, "allow");
});

// ---------------------------------------------------------------------------
// 重定向变体：无空格、>|、&>、fd 前缀；heredoc 标记不是重定向

test("redirect variants: no-space, >|, &>, and 2> all extract the sink file", () => {
  const cases = [
    ["echo x>.env", ".env"],
    ["echo x >|.env", ".env"],
    ["cmd &> .env", ".env"],
    ["cmd 2> err.log", "err.log"],
  ];
  for (const [cmd, sink] of cases) {
    const scan = evaluateBashCommand(cmd, CWD, policyWith({ denyWrite: [sink] }), NO_DECISIONS);
    assert.equal(scan.verdict.action, "deny", cmd);
    assert.ok(scan.target?.endsWith(sink), `${cmd} → ${scan.target}`);
  }
  // heredoc 的 << 不是重定向。
  assert.deepEqual(extractBashWriteTargets("cat <<EOF", CWD), []);
  assert.deepEqual(extractBashWriteTargets("cat <<'EOF'", CWD), []);
});

// ---------------------------------------------------------------------------
// 命令前缀跳过：sudo / env VAR=… / 裸 VAR=… / nohup / command

test("prefix wrappers are skipped before command identification", () => {
  for (const cmd of ["sudo rm .env", "env FOO=1 rm .env", "FOO=1 rm .env", "nohup rm .env", "command rm .env"]) {
    assert.deepEqual(extractBashWriteTargets(cmd, CWD), [`${CWD}/.env`], cmd);
  }
  const scan = evaluateBashCommand("sudo rm .env", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(scan.verdict.action, "deny");
  const outside = evaluateBashCommand("nohup cp a.txt /tmp/", CWD, DEFAULT_POLICY, NO_DECISIONS);
  assert.equal(outside.verdict.action, "ask");
});

// ---------------------------------------------------------------------------
// 内联执行兜底：INLINE_EXEC_RE 的全部触发形态（v2 之前只测了 python -c / sh -c）

test("inline execution detection covers all trigger forms", () => {
  for (const cmd of [
    'echo "$(cat .env)"', // $()
    "echo `cat .env`", // 反引号
    "cat <<EOF\n.env\nEOF", // heredoc
    `node -e "fs.writeFileSync('.env','x')"`, // node -e
    "eval 'cat .env'", // eval
    "python -c \"open('.env')\"", // python -c（回归）
    "bash -c 'cat .env'", // sh -c（回归）
  ]) {
    assert.equal(bashUsesInlineExecution(cmd), true, cmd);
  }
  assert.equal(bashUsesInlineExecution("grep -rn TODO src"), false);
});

test("inline execution fallback denies protected names for each trigger form", () => {
  const policy = policyWith({ denyWrite: [".env"] });
  for (const cmd of [
    'echo "$(cat .env)"',
    "echo `cat .env`",
    "cat <<EOF\n.env\nEOF",
    `node -e "fs.writeFileSync('.env','x')"`,
    "eval 'cat .env'",
  ]) {
    const scan = evaluateBashCommand(cmd, CWD, policy, NO_DECISIONS);
    assert.equal(scan.verdict.action, "deny", cmd);
    assert.match(scan.verdict.reason, /内联执行/);
  }
});

// ---------------------------------------------------------------------------
// local-machine：Windows 盘符 workspaceRoot 与反斜杠工具路径

test("drive-letter workspaces map through the scope like POSIX roots", () => {
  const scope = parsePathScope(JSON.stringify({ version: 1, mode: "local-machine", workspaceRoot: "C:/Users/u/proj" }));
  assert.ok(scope, "盘符根可用");
  assert.equal(mapToolPathToPolicy("C:/Users/u/proj/src/a.ts", CWD, scope), `${CWD}/src/a.ts`);
  // 工具路径用反斜杠（Go agent 返回 Windows 路径）同样映射。
  assert.equal(mapToolPathToPolicy("C:\\Users\\u\\proj\\.env", CWD, scope), `${CWD}/.env`);
  assert.equal(mapToolPathToPolicy("C:/Windows/System32/x.dll", CWD, scope), "C:/Windows/System32/x.dll", "区外原样");

  const read = evaluatePathAgainstPolicy("C:\\Users\\u\\proj\\.env", "read", CWD, DEFAULT_POLICY, NO_DECISIONS, scope);
  assert.equal(read.action, "deny", "映射后默认 denyRead 命中");
  const denied = evaluateBashCommand(
    "rm -rf C:/Users/u/proj/secrets",
    CWD,
    policyWith({ denyWrite: ["secrets/**"] }),
    NO_DECISIONS,
    scope,
  );
  assert.equal(denied.verdict.action, "deny", "bash 里的盘符路径同样先映射再判定");
});

// ---------------------------------------------------------------------------
// 持久决策语义：最新优先、目录覆盖子树、deny 决策压过 allowWrite

test("windows drive-letter absolute patterns match decisions and policy globs", () => {
  const winPath = "C:/work/proj/locked.txt";
  const BS = String.fromCharCode(92);
  const winBackslashPath = `C:${BS}work${BS}proj${BS}locked.txt`;
  const decisions = { version: 1, entries: [{ path: winPath, decision: "deny", at: 1 }] };
  assert.equal(
    evaluatePathAgainstPolicy(winBackslashPath, "write", "C:/work/proj", DEFAULT_POLICY, decisions).action,
    "deny",
    "盘符绝对路径的持久决策必须命中（历史 bug：被当成相对路径拼到 cwd 下）",
  );
  const policy = policyWith({ denyWrite: [winPath] });
  assert.equal(
    evaluatePathAgainstPolicy(winPath, "write", "C:/work/proj", policy, NO_DECISIONS).action,
    "deny",
    "盘符绝对 glob 同样必须生效",
  );
});

test("decisions: latest entry wins for the same path", () => {
  const stale = { version: 1, entries: [{ path: "/srv/x", decision: "deny", at: 1 }, { path: "/srv/x", decision: "allow", at: 2 }] };
  assert.equal(evaluatePathAgainstPolicy("/srv/x", "write", CWD, DEFAULT_POLICY, stale).action, "allow");
  const reversed = { version: 1, entries: [...stale.entries].reverse() };
  assert.equal(evaluatePathAgainstPolicy("/srv/x", "write", CWD, DEFAULT_POLICY, reversed).action, "deny");
});

test("decisions: a directory decision covers its subtree; deny beats allowWrite", () => {
  const dirDeny = { version: 1, entries: [{ path: `${CWD}/secrets`, decision: "deny", at: 1 }] };
  assert.equal(evaluatePathAgainstPolicy(`${CWD}/secrets/a.txt`, "write", CWD, DEFAULT_POLICY, dirDeny).action, "deny");
  // allow 决策同样按目录语义覆盖子树并放行工作区外路径。
  const dirAllow = { version: 1, entries: [{ path: "/srv", decision: "allow", at: 1 }] };
  assert.equal(evaluatePathAgainstPolicy("/srv/other/x.txt", "write", CWD, DEFAULT_POLICY, dirAllow).action, "allow");
});

// ---------------------------------------------------------------------------
// 自保护清单：文档 §2 列出的全部 12 项逐项验证（此前只断言了 4 项成员存在）

test("self-protected list: every documented pattern denies read and write", () => {
  const targets = [
    `${CWD}/.pi/path-policy.json`,
    `${CWD}/.pi/path-policy.decisions.json`,
    `${CWD}/.pi/path-policy.scope.json`,
    `${CWD}/.pi/guardrail-audit.jsonl`,
    `${CWD}/.pi/guardrail-audit.jsonl.1`,
    `${CWD}/.pi/sessions/abc/session.json`,
    `${CWD}/.pi/tmp/blob.bin`,
    `${CWD}/.pi/bin/tool.sh`,
    `${CWD}/.pi/cache/data.json`,
    `${CWD}/.pi/plans/p.json`,
    `${CWD}/.pi/auth.json`,
    `${CWD}/.pi/ssh.json`,
    `${CWD}/.pi/sandbox-platform.json`,
    `${CWD}/.ssh/id_rsa`,
  ];
  assert.equal(targets.length, SELF_PROTECTED_PATTERNS.length, "清单与测试逐项对齐");
  for (const target of targets) {
    assert.equal(evaluatePathAgainstPolicy(target, "write", CWD, DEFAULT_POLICY, NO_DECISIONS).action, "deny", target);
    assert.equal(evaluatePathAgainstPolicy(target, "read", CWD, DEFAULT_POLICY, NO_DECISIONS).action, "deny", target);
  }
  // 远端路径空间：映射后自保护同样生效。
  const scope = parsePathScope(JSON.stringify({ version: 1, mode: "sandbox", workspaceRoot: "/workspace" }));
  assert.equal(
    evaluatePathAgainstPolicy("/workspace/.ssh/authorized_keys", "read", CWD, DEFAULT_POLICY, NO_DECISIONS, scope).action,
    "deny",
  );
});

test("background-task logs are readable but remain write-protected", () => {
  const log = `${CWD}/.pi/tmp/bg/bg-abcd1234.log`;
  assert.equal(evaluatePathAgainstPolicy(log, "read", CWD, DEFAULT_POLICY, NO_DECISIONS).action, "allow");
  assert.equal(evaluatePathAgainstPolicy(log, "write", CWD, DEFAULT_POLICY, NO_DECISIONS).action, "deny");
  // The exception is limited to .pi/tmp/bg/**; other runtime files stay opaque.
  assert.equal(
    evaluatePathAgainstPolicy(`${CWD}/.pi/tmp/other.bin`, "read", CWD, DEFAULT_POLICY, NO_DECISIONS).action,
    "deny",
  );
});

// ---------------------------------------------------------------------------
// 归一化与主目录字面量

test("normalizePolicyPath: .. collapses in absolute paths but stays literal at relative heads", () => {
  assert.equal(normalizePolicyPath("a/../../b"), "../b");
  assert.equal(normalizePolicyPath("/a/../../b"), "/b");
  assert.equal(normalizePolicyPath("C:\\Users\\x"), "C:/Users/x");
  assert.equal(normalizePolicyPath("/tmp/"), "/tmp");
});

test("~ paths are treated as outside the workspace (ask), never silently allowed", () => {
  assert.deepEqual(extractBashWriteTargets("rm ~/secret.txt", CWD), ["~/secret.txt"]);
  assert.equal(evaluateBashCommand("rm ~/secret.txt", CWD, DEFAULT_POLICY, NO_DECISIONS).verdict.action, "ask");
  assert.equal(evaluatePathAgainstPolicy("~/secret.txt", "write", CWD, DEFAULT_POLICY, NO_DECISIONS).action, "ask");
});
