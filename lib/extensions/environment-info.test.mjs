import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/** Environment prompt block only — the portable context_status tool moved to
 *  the shared amedac-core package (see context-status.test.mjs). */

async function loadSubject() {
  return import("./environment-info.ts");
}

async function loadExtension(info) {
  const mod = await loadSubject();
  const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  mod.makeEnvironmentInfoExtension(info)(pi);
  return { handlers };
}

test("environment block rides the system prompt (sentinel-delimited, idempotent)", async () => {
  const { handlers } = await loadExtension({ mode: "ssh", username: "ops" });
  const inject = handlers.get("before_agent_start")[0];
  const first = await inject({ systemPrompt: "BASE" });
  assert.match(first.systemPrompt, /PI_WEB_ENV_BEGIN/);
  assert.match(first.systemPrompt, /远程主机/);
  // Re-injecting over an already-injected prompt replaces, not duplicates.
  const second = await inject({ systemPrompt: first.systemPrompt });
  assert.equal(second.systemPrompt.match(/PI_WEB_ENV_BEGIN/g).length, 1);
});

// 远程工作区模式的提示词裁剪：Pi 文档块 + 宿主 cwd 行都必须消失（宿主 cwd
// 是中心服务器上的配置载体目录，既误导模型又泄露服务器路径）；环境说明由
// PI_WEB_ENV 承担。Host 模式保留两者（管理员真实的服务器目录）。
const SDK_BASE = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Guidelines:",
  "- Be concise in your responses",
  "",
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
  "- Main documentation: /opt/pi/README.md",
  "- Examples: /opt/pi/examples (extensions, custom tools, SDK)",
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
  "",
  "Current working directory: /home/llmx/amedac/piweb-data/sandbox-homes/u1/cafe",
].join("\n");

test("remote workspace modes drop the pi docs block and the server cwd line", async () => {
  for (const mode of ["sandbox", "local-machine", "ssh"]) {
    const { handlers } = await loadExtension({ mode, username: "ops", workspaceDir: "/home/me/proj" });
    const inject = handlers.get("before_agent_start")[0];
    const out = (await inject({ systemPrompt: SDK_BASE })).systemPrompt;
    assert.ok(!out.includes("Pi documentation"), `${mode}: docs block removed`);
    assert.ok(!out.includes("Current working directory"), `${mode}: cwd line removed`);
    assert.ok(!out.includes("/home/llmx/amedac"), `${mode}: server path must not leak`);
    // 环境说明仍然注入（模型仍知道工具在哪里执行）。
    assert.match(out, /PI_WEB_ENV_BEGIN/);
    assert.match(out, mode === "sandbox" ? /沙箱容器/ : mode === "ssh" ? /远程主机/ : /用户本机/);
  }
});

test("host mode keeps the docs block and its real server cwd", async () => {
  const { handlers } = await loadExtension({ mode: "host", username: "admin", hostDir: "/srv/lab" });
  const inject = handlers.get("before_agent_start")[0];
  const out = (await inject({ systemPrompt: SDK_BASE })).systemPrompt;
  assert.match(out, /Pi documentation/);
  assert.match(out, /Current working directory: \/home\/llmx/);
});

test("registers no tools of its own anymore", async () => {
  const mod = await loadSubject();
  const tools = [];
  const pi = { on: () => {}, registerTool: (t) => tools.push(t) };
  mod.makeEnvironmentInfoExtension({ mode: "host", username: "admin" })(pi);
  assert.deepEqual(tools, []);
});

// 防漂移：用真实安装的 SDK 构建基础提示词（docs 块 + cwd 行都在），再走
// environment-info 的 before_agent_start，确认远程模式的裁剪对真实文本生效。
// 上游改写锚点措辞时这里会红，提示更新 lib/prompt-sections.ts 的锚点。
test("real SDK base prompt: remote modes strip docs and server cwd end to end", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { buildSystemPrompt } = await jiti.import(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
  );
  const tools = ["bash", "read", "write", "edit"];
  const base = buildSystemPrompt({
    selectedTools: tools,
    toolSnippets: Object.fromEntries(tools.map((t) => [t, `${t} one-line description`])),
    promptGuidelines: [],
    cwd: "/home/llmx/amedac/piweb-data/sandbox-homes/u1/stale",
  });
  assert.ok(base.includes("Pi documentation"), "precondition: upstream still ships the docs block");
  assert.ok(
    base.includes("Current working directory: /home/llmx/amedac"),
    "precondition: upstream still appends the session cwd",
  );

  const { handlers } = await loadExtension({ mode: "sandbox", username: "ops" });
  const out = (await handlers.get("before_agent_start")[0]({ systemPrompt: base })).systemPrompt;
  assert.ok(!out.includes("Pi documentation"));
  assert.ok(!out.includes("Current working directory"));
  assert.ok(!out.includes("/home/llmx/amedac"));
  assert.match(out, /PI_WEB_ENV_BEGIN/);
});
