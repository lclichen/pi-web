import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  TOOL_MANIFEST,
  REGISTERED_TOOL_NAMES,
  BUILTIN_CODING_TOOL_NAMES,
  AMEDAC_CORE_TOOL_NAMES,
  PI_WEB_TOOL_NAMES,
  EXTENSION_TOOL_NAMES,
  isToolAllowedInMode,
} = await jiti.import("../pi-config/agent/extensions/amedac-core/src/tool-manifest.ts");

/**
 * 工具护栏引入门禁（docs/dev/tool-guardrails-design.md 附录 A）：
 * 代码里注册的工具名集合必须与 tool-manifest.ts 完全一致——新增/改名/
 * 删除工具而不更新声明 => 本文件失败。声明结构不完整（workspace 缺远端
 * 通道、commandParams 不带 exec 风险等）同样失败。
 */

const root = new URL("../", import.meta.url);
const read = (rel) => readFile(new URL(rel, root), "utf8");

test("every registered tool name has exactly one manifest entry (and vice versa)", () => {
  const names = TOOL_MANIFEST.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, "manifest 内名字唯一");
  const registered = new Set(REGISTERED_TOOL_NAMES);
  assert.equal(registered.size, REGISTERED_TOOL_NAMES.length, "注册源清单内名字唯一");
  for (const name of names) assert.ok(registered.has(name), `manifest 多出未注册工具：${name}`);
  for (const name of REGISTERED_TOOL_NAMES) assert.ok(names.includes(name), `注册工具缺 manifest 声明：${name}`);
});

test("workspace entries declare all three remote channels; host entries do not need them", () => {
  for (const entry of TOOL_MANIFEST) {
    if (entry.plane === "workspace") {
      assert.ok(entry.remote, `${entry.name}: workspace 工具必须声明远端语义`);
      for (const channel of ["sandbox", "local-machine", "ssh"]) {
        assert.ok(entry.remote[channel], `${entry.name}: 缺 ${channel} 通道声明`);
      }
    }
  }
});

test("security hooks are consistent with the risk class", () => {
  for (const entry of TOOL_MANIFEST) {
    if (entry.commandParams?.length) {
      assert.equal(entry.risk, "exec", `${entry.name}: 命令参数只属于 exec 类工具`);
    }
    if (entry.pathParams?.length) {
      assert.ok(entry.risk === "read" || entry.risk === "write", `${entry.name}: 路径参数要求 read/write 风险类`);
    }
    if (entry.risk === "write") {
      assert.ok(entry.pathParams?.length, `${entry.name}: write 工具必须声明 pathParams（否则写路径不受检）`);
    }
    if (entry.modes) {
      assert.ok(entry.modes.length > 0 && entry.modes.every(Boolean), `${entry.name}: modes 不能为空`);
    }
  }
});

test("drift guard: amedac-core source still registers exactly the declared tool names", async () => {
  const sources = {
    "src/todo.ts": ["todo"],
    "src/session-plan.ts": ["plan_save"],
    "src/plan-mode.ts": ["enter_plan_mode", "exit_plan_mode"],
    "src/context-status.ts": ["context_status"],
    "src/bg-shell.ts": ["bg_run", "bg_list", "bg_stop"],
  };
  for (const [file, expected] of Object.entries(sources)) {
    const src = await read(`pi-config/agent/extensions/amedac-core/${file}`);
    for (const name of expected) {
      assert.ok(src.includes(`name: "${name}"`), `${file} 不再注册 ${name}（或改名未同步 manifest）`);
    }
    const registeredHere = AMEDAC_CORE_TOOL_NAMES.filter((n) => expected.includes(n));
    assert.equal(registeredHere.length, expected.length, `${file} 的声明集合与源码不一致`);
  }
});

test("drift guard: SDK builtin names match lib/rpc-manager.ts CODING_TOOL_NAMES", async () => {
  const src = await read("lib/rpc-manager.ts");
  const match = src.match(/const CODING_TOOL_NAMES = \[([^\]]+)\]/);
  assert.ok(match, "找不到 CODING_TOOL_NAMES 定义（改名需同步本测试）");
  const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, [...BUILTIN_CODING_TOOL_NAMES], "内置工具清单与 manifest 不一致");
});

test("drift guard: pi-web inline tools are still registered under the declared names", async () => {
  const share = await read("lib/extensions/share.ts");
  for (const name of ["share_file"]) assert.ok(share.includes(`name: "${name}"`), `share.ts 缺 ${name}`);
  const subagent = await read("lib/subagent-extension.ts");
  for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) {
    assert.ok(subagent.includes(`name: "${name}"`), `subagent-extension.ts 缺 ${name}`);
  }
  assert.deepEqual([...PI_WEB_TOOL_NAMES], ["share_file", "Agent", "get_subagent_result", "steer_subagent"]);

  const ask = await read("pi-config/agent/extensions/rpiv-ask-user-question/ask-user-question.ts");
  assert.ok(ask.includes('ASK_USER_QUESTION_TOOL_NAME = "ask_user_question"'), "问询工具注册名漂移");
  assert.deepEqual([...EXTENSION_TOOL_NAMES], ["ask_user_question"]);
});

test("mode compatibility: unsupported channels clamp, declared channels pass", async () => {
  const byName = Object.fromEntries(TOOL_MANIFEST.map((e) => [e.name, e]));
  // workspace + 全通道：三远端模式均可用。
  for (const mode of ["sandbox", "ssh", "local-machine"]) {
    assert.equal(isToolAllowedInMode(byName.bash, mode), true, `bash/${mode}`);
  }
  // powershell 远端未代理：三个远端模式全部不可用（host/quick 仍可用）。
  for (const mode of ["sandbox", "ssh", "local-machine"]) {
    assert.equal(isToolAllowedInMode(byName.powershell, mode), false, `powershell/${mode}`);
  }
  assert.equal(isToolAllowedInMode(byName.powershell, "host"), true);
  // bg_run 三通道 bg-channel：全模式可用。
  for (const mode of ["host", "sandbox", "ssh", "local-machine"]) {
    assert.equal(isToolAllowedInMode(byName.bg_run, mode), true, `bg_run/${mode}`);
  }
  // host 工具全模式可用。
  for (const mode of ["host", "quick", "sandbox", "ssh", "local-machine"]) {
    assert.equal(isToolAllowedInMode(byName.todo ?? byName.context_status, mode), true);
  }
});
