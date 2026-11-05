import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { makePathGuardExtension } = await jiti.import("../pi-config/agent/extensions/amedac-core/src/path-guard.ts");

/** 最小 pi/ctx 桩：捕获 tool_call 处理器，可控 UI。 */
function harness({ hasUI = true, choice, selectThrows = false } = {}) {
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
  };
  const verdicts = [];
  let asked = 0;
  const ext = makePathGuardExtension({ onVerdict: (v) => verdicts.push(v) });
  ext(pi);
  const ctx = {
    hasUI,
    cwd: "",
    ui: hasUI
      ? {
          select: async () => {
            asked += 1;
            if (selectThrows) throw new Error("select failed");
            return choice;
          },
        }
      : {
          select: async () => {
            throw new Error("no ui");
          },
        },
  };
  return {
    call: (toolName, input, cwd) => {
      ctx.cwd = cwd;
      return handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName, input }, ctx);
    },
    verdicts,
    asked: () => asked,
  };
}

test("write inside workspace passes; outside is blocked headless with a teachable reason", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    const inside = await h.call("write", { path: join(cwd, "src/a.ts"), content: "x" }, cwd);
    assert.equal(inside, undefined, "工作区内写入不拦截");

    const outside = await h.call("write", { path: "/srv/data/out.ts", content: "x" }, cwd);
    assert.equal(outside.block, true);
    assert.match(outside.reason, /无人值守/);

    const protectedPath = await h.call("write", { path: join(cwd, ".pi/path-policy.json"), content: "{}" }, cwd);
    assert.equal(protectedPath.block, true);
    assert.match(protectedPath.reason, /受保护/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash redirect outside the workspace is blocked headless; read-only commands pass", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    const grep = await h.call("bash", { command: "grep foo bar.txt" }, cwd);
    assert.equal(grep, undefined);
    const redirect = await h.call("bash", { command: `echo hi > /srv/out.log` }, cwd);
    assert.equal(redirect.block, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("interactive ask: deny-and-never-again persists to the decisions file and blocks next time without asking", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    // 第一次选择“拒绝且不再询问”
    const h1 = harness({ hasUI: true, choice: "拒绝且不再询问（写入决策文件）" });
    const r1 = await h1.call("write", { path: "/srv/data/out.ts", content: "x" }, cwd);
    assert.equal(r1.block, true);
    assert.ok(existsSync(join(cwd, ".pi/path-policy.decisions.json")), "决策文件应落盘");
    const persisted = JSON.parse(readFileSync(join(cwd, ".pi/path-policy.decisions.json"), "utf8"));
    assert.equal(persisted.entries[0].decision, "deny");
    // 决策记录精确路径（不从单文件泛化到目录）
    assert.equal(persisted.entries[0].path, "/srv/data/out.ts");

    // 第二次（新会话实例、UI 无人应答）：同一路径不再询问，按持久决策拒绝
    const h2 = harness({ hasUI: true, choice: undefined });
    const r2 = await h2.call("write", { path: "/srv/data/out.ts", content: "x" }, cwd);
    assert.equal(r2.block, true);
    assert.match(r2.reason, /不再询问/);

    // 同目录的其它文件不继承决策（精确授权语义）→ 仍会询问；无人应答按拒绝处理
    const r3 = await h2.call("write", { path: "/srv/data/other.ts", content: "x" }, cwd);
    assert.equal(r3.block, true);
    assert.doesNotMatch(r3.reason, /不再询问/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("interactive ask: allow-once passes the call and does not persist", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: true, choice: "允许一次" });
    const r = await h.call("write", { path: "/srv/once.ts", content: "x" }, cwd);
    assert.equal(r, undefined, "允许一次 → 本次放行");
    assert.equal(existsSync(join(cwd, ".pi/path-policy.decisions.json")), false, "不落盘");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("project policy file is honored (locked modes simply read the same file)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi/path-policy.json"),
      JSON.stringify({
        version: 1,
        allowWrite: ["src"],
        denyWrite: [],
        denyRead: [],
        askOnOutsideWrite: false,
      }),
    );
    const h = harness({ hasUI: true, choice: "允许一次" });
    // src 内放行
    assert.equal(await h.call("write", { path: join(cwd, "src/a.ts"), content: "x" }, cwd), undefined);
    // askOnOutsideWrite=false：工作区外直接拒（不询问）
    const r = await h.call("write", { path: join(cwd, "docs/a.md"), content: "x" }, cwd);
    assert.equal(r.block, true);
    assert.match(r.reason, /askOnOutsideWrite/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 覆盖补全（docs/dev/path-policy-guardrails.md 声称能力与工具覆盖表的锁定）。

test("read/grep tool calls are evaluated against denyRead at the tool_call layer", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    // read：默认 denyRead 命中 .env（此前只有纯函数层测试，工具名单改动无人知晓）。
    const read = await h.call("read", { path: join(cwd, ".env") }, cwd);
    assert.equal(read.block, true);
    assert.match(read.reason, /denyRead/);
    // grep：默认 denyRead 命中 .git/config。
    const grep = await h.call("grep", { path: join(cwd, ".git/config"), pattern: "url" }, cwd);
    assert.equal(grep.block, true);
    // 正常读取放行。
    assert.equal(await h.call("read", { path: join(cwd, "src/a.ts") }, cwd), undefined);
    assert.equal(await h.call("ls", { path: join(cwd, "src") }, cwd), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("powershell tool shares the bash scanning pipeline (cmdlet write targets)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    const r = await h.call("powershell", { command: "remove-item -recurse .env" }, cwd);
    assert.equal(r.block, true);
    assert.match(r.reason, /denyWrite/);
    assert.equal(await h.call("powershell", { command: "get-child-item src" }, cwd), undefined, "只读 cmdlet 放行");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bg_run is intercepted through commandParams; undeclared tools stay passthrough", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    // bg_run 与 bash 共享命令护栏（tool-manifest.ts 的 commandParams）——
    // 设计文档缺口 G2（此前完全绕过路径护栏）已由 P0 收编。
    const deny = await h.call("bg_run", { command: "rm .env" }, cwd);
    assert.equal(deny.block, true);
    assert.match(deny.reason, /denyWrite/);
    const outside = await h.call("bg_run", { command: "echo x > /srv/out.log" }, cwd);
    assert.equal(outside.block, true);
    assert.match(outside.reason, /无人值守/);
    assert.equal(await h.call("bg_run", { command: "npm test" }, cwd), undefined, "工作区内命令放行");
    // 未声明参数的工具保持 passthrough：MCP direct tool（P1 的 piWeb 声明收口）
    // 与 host 状态工具（bg_list/todo 无工作区副作用，manifest plane=host）。
    assert.equal(await h.call("docsfs_read_file", { path: "/etc/shadow" }, cwd), undefined);
    assert.equal(await h.call("todo", { todos: [] }, cwd), undefined);
    assert.equal(await h.call("bg_list", {}, cwd), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("share_file participates in path policy through its declared pathParams", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    // manifest: share_file = host/read + pathParams ["path"] → denyRead 生效，
    // 避免把凭据文件生成下载链接。
    const denied = await h.call("share_file", { path: join(cwd, ".env") }, cwd);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /denyRead/);
    assert.equal(await h.call("share_file", { path: join(cwd, "report.pdf") }, cwd), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("interactive ask: allow-always persists an allow decision honored by later sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h1 = harness({ hasUI: true, choice: "本项目始终允许（写入决策文件）" });
    assert.equal(await h1.call("write", { path: "/srv/shared/out.ts", content: "x" }, cwd), undefined);
    const persisted = JSON.parse(readFileSync(join(cwd, ".pi/path-policy.decisions.json"), "utf8"));
    assert.equal(persisted.entries[0].decision, "allow");
    assert.equal(persisted.entries[0].path, "/srv/shared/out.ts");

    // 新会话实例（UI 无人应答）：同路径按持久 allow 放行，不再询问。
    const h2 = harness({ hasUI: true, choice: undefined });
    assert.equal(await h2.call("write", { path: "/srv/shared/out.ts", content: "x" }, cwd), undefined);
    assert.equal(h2.asked(), 0, "持久 allow 不再触发询问");
    // 兄弟路径不继承精确文件决策 → 询问，无人应答按拒绝处理。
    const sibling = await h2.call("write", { path: "/srv/shared/other.ts", content: "x" }, cwd);
    assert.equal(sibling.block, true);
    assert.equal(h2.asked(), 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("interactive ask: directory targets persist as subtree-covering decisions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    // bash 对目录目标（rm -rf dir）询问后"始终允许"：记录的是目录路径，
    // 后续会话里该子树内的删除不再询问（决策路径按 glob 目录语义覆盖子树）。
    const h1 = harness({ hasUI: true, choice: "本项目始终允许（写入决策文件）" });
    assert.equal(await h1.call("bash", { command: "rm -rf /srv/gen" }, cwd), undefined);
    const h2 = harness({ hasUI: true, choice: undefined });
    assert.equal(await h2.call("bash", { command: "rm -rf /srv/gen/nested/deep.log" }, cwd), undefined);
    assert.equal(h2.asked(), 0, "目录决策覆盖子树");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("interactive ask: plain deny and UI failure deny without persisting anything", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h1 = harness({ hasUI: true, choice: "拒绝" });
    const r1 = await h1.call("write", { path: "/srv/x.ts", content: "x" }, cwd);
    assert.equal(r1.block, true);
    assert.match(r1.reason, /拒绝了本次操作/);
    assert.doesNotMatch(r1.reason, /不再询问/);
    assert.equal(existsSync(join(cwd, ".pi/path-policy.decisions.json")), false, "普通拒绝不落盘");

    // UI 选择器抛异常（通道故障）按未选择处理 → 拒绝且不落盘，不静默放行。
    const h2 = harness({ hasUI: true, selectThrows: true });
    const r2 = await h2.call("write", { path: "/srv/y.ts", content: "x" }, cwd);
    assert.equal(r2.block, true);
    assert.match(r2.reason, /拒绝了本次操作/);
    assert.equal(existsSync(join(cwd, ".pi/path-policy.decisions.json")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash ask: allow-once is session-scoped and tracked per target", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h1 = harness({ hasUI: true, choice: "允许一次" });
    assert.equal(await h1.call("bash", { command: "echo hi > /srv/once.log" }, cwd), undefined, "首次询问后放行");
    assert.equal(h1.verdicts[0].via, "ask");
    assert.equal(await h1.call("bash", { command: "echo hi > /srv/once.log" }, cwd), undefined, "同会话同目标不再询问");
    assert.equal(h1.asked(), 1, "第二次没有再弹询问");
    assert.equal(existsSync(join(cwd, ".pi/path-policy.decisions.json")), false, "允许一次不落盘");
    // 其它目标不搭便车：仍要询问（choice 仍是允许一次，故放行但计数增加）。
    assert.equal(await h1.call("bash", { command: "echo hi > /srv/other.log" }, cwd), undefined);
    assert.equal(h1.asked(), 2);
    // 新会话实例：内存 once-allow 失效，重新询问；无人应答 → 拒绝。
    const h2 = harness({ hasUI: true, choice: undefined });
    const r = await h2.call("bash", { command: "echo hi > /srv/once.log" }, cwd);
    assert.equal(r.block, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("~ literal paths are evaluated as outside-workspace, never silently allowed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    const r = await h.call("write", { path: "~/secret.txt", content: "x" }, cwd);
    assert.equal(r.block, true);
    assert.match(r.reason, /无人值守/, "ask 分支在无 UI 会话收敛为拒绝");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("degenerate inputs pass through without throwing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    assert.equal(await h.call("write", { path: "   ", content: "x" }, cwd), undefined, "空白路径不拦");
    assert.equal(await h.call("write", { content: "x" }, cwd), undefined, "缺 path 不拦");
    assert.equal(await h.call("bash", { command: 123 }, cwd), undefined, "非字符串 command 不拦");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("decision file is capped at 500 entries (oldest evicted)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const entries = Array.from({ length: 500 }, (_, i) => ({ path: `/srv/f${i}`, decision: "deny", at: i }));
    writeFileSync(join(cwd, ".pi/path-policy.decisions.json"), JSON.stringify({ version: 1, entries }));

    const h = harness({ hasUI: true, choice: "拒绝且不再询问（写入决策文件）" });
    const r = await h.call("write", { path: "/srv/new.ts", content: "x" }, cwd);
    assert.equal(r.block, true);
    const persisted = JSON.parse(readFileSync(join(cwd, ".pi/path-policy.decisions.json"), "utf8"));
    assert.equal(persisted.entries.length, 500, "封顶 500");
    assert.equal(persisted.entries[499].path, "/srv/new.ts", "新决策在尾部");
    assert.equal(persisted.entries[0].path, "/srv/f1", "最旧的被裁掉");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("onVerdict reports rule / headless-deny outcomes with the policy-space path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pg-"));
  try {
    const h = harness({ hasUI: false });
    await h.call("write", { path: join(cwd, ".env"), content: "x" }, cwd); // 规则拒绝
    await h.call("write", { path: "/srv/z.ts", content: "x" }, cwd); // ask → 无人值守拒绝
    const envPath = join(cwd, ".env").replace(/\\/g, "/");
    assert.deepEqual(h.verdicts, [
      { tool: "write", path: envPath, action: "deny", via: "rule" },
      { tool: "write", path: "/srv/z.ts", action: "deny", via: "headless-deny" },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
