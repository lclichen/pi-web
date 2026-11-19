/**
 * Embed 协议的 agent 命令 type 分档（P2-6）。
 *
 * 产品 profile 的 allowedCommands 只约束 slash 命令名（prompt 文本里的
 * /command）；这里再按命令 type 收紧 `POST /api/agent/[id]` 的命令面，否则
 * token 持有者可以发 set_tools 放开会话工具集、fork 分叉出产品管理之外的
 * 新会话。实现为显式集合 + 拒绝优先；未知命令默认拒绝（default-deny，与
 * lib/embed-auth.ts 的 isEmbedApiAllowed 同风格）。
 *
 * 纯函数、无 node 依赖，便于服务端闸门与测试复用。
 */

/** 变更会话安全属性或逃出产品作用域的命令——产品 token 一律拒绝。 */
const EMBED_DENIED_AGENT_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "set_tools", // 重开会话工具集，绕过产品工具档位
  "fork", // 在产品管理之外分叉新会话
]);

/**
 * 嵌入聊天面实际用到的命令 type。清单依据：hooks/useAgentSession.ts 的
 * sendAgentCommand 调用点 + 嵌入 UI（ChatWindow/ChatInput）未按
 * `embedded` 隐藏的功能：
 * - steering 队列与压缩控制（队列条 / 压缩横幅在嵌入页渲染）；
 * - 内建 slash 命令映射：/reload→reload、/name→set_session_name、
 *   /clone→clone、/copy→get_last_assistant_text、/session→get_session_stats
 *   （slash 名本身仍受产品 allowedCommands 约束）；
 * - `!` shell 直通（bash/abort_bash，仍在会话工具策略内执行）；
 * - 扩展交互组件回传（ExtensionDialog / ExtensionWidgets 在嵌入页渲染）。
 */
const EMBED_ALLOWED_AGENT_COMMAND_TYPES: ReadonlySet<string> = new Set([
  // 核心对话流
  "prompt",
  "steer",
  "abort",
  "compact",
  // 会话内配置与树导航（不改变会话安全属性）
  "set_model",
  "set_thinking_level",
  "navigate_tree",
  // 内建 slash 命令映射出的命令 type
  "reload",
  "set_session_name",
  "clone",
  // steering 队列与压缩控制
  "update_queue",
  "clear_queue",
  "abort_compaction",
  // `!` shell 直通（嵌入 composer 未禁用）
  "bash",
  "abort_bash",
  // 扩展交互组件的回传
  "extension_ui_response",
  "extension_ui_input",
]);

/**
 * embed token 是否允许发送该命令 type。拒绝优先；显式允许集合之外仅放行
 * `get_` 前缀的只读命令；其余（含空 type）一律拒绝。
 */
export function isEmbedAgentCommandTypeAllowed(type: string): boolean {
  if (EMBED_DENIED_AGENT_COMMAND_TYPES.has(type)) return false;
  if (EMBED_ALLOWED_AGENT_COMMAND_TYPES.has(type)) return true;
  return type.startsWith("get_");
}
