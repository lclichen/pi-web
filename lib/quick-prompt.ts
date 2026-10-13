/**
 * 快速会话的基础系统提示词适配（瑕疵段替换）。
 *
 * pi 的 buildSystemPrompt 固定核心文本里有两段对快速会话不成立：
 *   1. 身份段宣称"读文件/执行命令/改代码"——quick 没有这些工具；
 *   2. pi 文档索引块（~180 tokens）——面向 pi 二开用户，quick 是死重。
 *
 * 经 resourceLoaderOptions.systemPromptOverride（官方转换钩子）对基础段做
 * 文本替换：身份段换成 quick 语义，文档块整段移除。锚点都是 pi 上游原文；
 * 上游改词后替换会静默失效——lib/quick-prompt.test.mjs 用**真实安装的
 * SDK** 构建 quick 形态的基础提示词做断言，依赖一更新就会红，防漂移。
 */

export const QUICK_IDENTITY_ORIGINAL =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export const QUICK_IDENTITY_REPLACEMENT =
  "You are a helpful assistant in pi-web's quick session mode — a lightweight conversation with no workspace: there are no file, command, or coding tools here. Answer the user directly; if a tools list is present, those tools (typically external MCP tools) are the ones you may call.";

const DOCS_BLOCK_START = "Pi documentation (read only when the user asks";
const DOCS_BLOCK_END = "(e.g., tui.md for TUI API details)";

/** 替换是否完整生效（测试与诊断用；部分命中=上游改词，需要更新锚点）。 */
export function quickPromptAdaptationReport(base: string): {
  identityReplaced: boolean;
  docsRemoved: boolean;
} {
  return {
    identityReplaced: !base.includes(QUICK_IDENTITY_ORIGINAL),
    docsRemoved: !base.includes(DOCS_BLOCK_START) && !base.includes(DOCS_BLOCK_END),
  };
}

/** 适配快速会话的基础系统提示词；锚点未命中时原样返回对应段落（不猜）。 */
export function adaptQuickBasePrompt(base: string): string {
  let out = base;
  if (out.includes(QUICK_IDENTITY_ORIGINAL)) {
    out = out.replace(QUICK_IDENTITY_ORIGINAL, QUICK_IDENTITY_REPLACEMENT);
  }
  const start = out.indexOf(DOCS_BLOCK_START);
  if (start >= 0) {
    const end = out.indexOf(DOCS_BLOCK_END, start);
    if (end >= 0) {
      // 移除 [start, end] 整块（含首尾锚点），收拾残留的空行。
      const after = out.slice(end + DOCS_BLOCK_END.length);
      out = out.slice(0, start) + after.replace(/^[ \t]*\r?\n/, "");
      // 块前通常留有一个空行分隔——去掉后若出现三个以上连续换行再压一层。
      out = out.replace(/\n{3,}/g, "\n\n");
    }
  }
  return out;
}
