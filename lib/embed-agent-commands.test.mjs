import assert from "node:assert/strict";
import test from "node:test";

const { isEmbedAgentCommandTypeAllowed } = await import("./embed-agent-commands.ts");

test("denies commands that change session safety properties or escape the product scope", () => {
  assert.equal(isEmbedAgentCommandTypeAllowed("set_tools"), false);
  assert.equal(isEmbedAgentCommandTypeAllowed("fork"), false);
});

test("allows the embed chat surface command types", () => {
  // 核心对话流
  for (const type of ["prompt", "steer", "abort", "compact"]) {
    assert.equal(isEmbedAgentCommandTypeAllowed(type), true, type);
  }
  // 会话内配置与树导航
  for (const type of ["set_model", "set_thinking_level", "navigate_tree"]) {
    assert.equal(isEmbedAgentCommandTypeAllowed(type), true, type);
  }
  // 嵌入 UI 实际使用的其余命令 type（详见 lib 注释清单）
  for (const type of [
    "reload",
    "set_session_name",
    "clone",
    "update_queue",
    "clear_queue",
    "abort_compaction",
    "bash",
    "abort_bash",
    "extension_ui_response",
    "extension_ui_input",
  ]) {
    assert.equal(isEmbedAgentCommandTypeAllowed(type), true, type);
  }
});

test("allows read-only get_ prefixed commands but default-denies everything else", () => {
  assert.equal(isEmbedAgentCommandTypeAllowed("get_commands"), true);
  assert.equal(isEmbedAgentCommandTypeAllowed("get_state"), true);
  assert.equal(isEmbedAgentCommandTypeAllowed("get_tools"), true);
  assert.equal(isEmbedAgentCommandTypeAllowed("get_session_stats"), true);
  assert.equal(isEmbedAgentCommandTypeAllowed("get_last_assistant_text"), true);
  assert.equal(isEmbedAgentCommandTypeAllowed("get_future_readonly"), true);
  // 未知命令默认拒绝；getset_/set_ 前缀不因包含 get_ 而放行
  assert.equal(isEmbedAgentCommandTypeAllowed("apply_preferences"), false);
  assert.equal(isEmbedAgentCommandTypeAllowed("set_session_name_x"), false);
  assert.equal(isEmbedAgentCommandTypeAllowed("getshell"), false);
  assert.equal(isEmbedAgentCommandTypeAllowed(""), false);
  assert.equal(isEmbedAgentCommandTypeAllowed("get_"), true);
});
