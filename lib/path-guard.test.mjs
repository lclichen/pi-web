import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { makePathGuardExtension } = await jiti.import("../pi-config/agent/extensions/amedac-core/src/path-guard.ts");

/** 最小 pi/ctx 桩：捕获 tool_call 处理器，可控 UI。 */
function harness({ hasUI = true, choice } = {}) {
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
  };
  const verdicts = [];
  const ext = makePathGuardExtension({ onVerdict: (v) => verdicts.push(v) });
  ext(pi);
  const ctx = {
    hasUI,
    cwd: "",
    ui: hasUI
      ? { select: async () => choice }
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
