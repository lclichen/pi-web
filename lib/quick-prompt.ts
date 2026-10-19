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

// ---------------------------------------------------------------------------
// before_agent_start 扩展：quick 提示词改写的正确挂点。
//
// 为什么不是 loader 选项（2026-10-13 dev 实测推翻）：resourceLoader 的
// systemPromptOverride 只作用于"发现的 prompt 文件/customPrompt 输入"，
// appendSystemPrompt 数组会被当文件路径解析（不存在即被过滤）——两者都
// 够不到 agent-session 装配后的基础段（工具列表/准则/文档块）。而
// before_agent_start 收到的 event.systemPrompt 正是装配后的完整提示词
//（environment-info 同款机制），在每回合上做改写并返回 { systemPrompt }。
// ---------------------------------------------------------------------------

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createHash } from "crypto";

/**
 * 提示词一致性探针（PI_WEB_LOG_PROMPT_HASH=1 开启）：每回合记录 SDK base
 * 与合成后提示词的 sha1 前 12 位。base 哈希跨回合变化 = 模型前缀缓存被打断
 *（系统提示词位于前缀最前端，一个字节的变化使全部历史的缓存失效）。
 */
function promptHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** 幂等地把模板提示词附加到（已适配的）提示词尾部——每回合触发也不重复。 */
export function appendTemplateOnce(prompt: string, template: string): string {
  if (!template.trim()) return prompt;
  if (prompt.includes(template)) return prompt;
  const base = prompt.trimEnd();
  return base ? `${base}\n\n${template}` : template;
}

/** 组合变换：基础段适配（身份/文档块）→ 模板附加。纯函数，单测直接钉。 */
export function composeQuickSystemPrompt(base: string, template?: string): string {
  let out = adaptQuickBasePrompt(base);
  if (template) out = appendTemplateOnce(out, template);
  return out;
}

/**
 * quick 会话的提示词扩展：每回合 before_agent_start 上改写 systemPrompt。
 * webUiPrompt 的附加段经 wrapper 的 continuation 在更外层追加，最终顺序：
 * 适配后基础段 → 模板 → Web 输出附加段。
 */
/** 模板内容的可变持有者：apply_quick_template 热切换时原地更新。 */
export interface QuickTemplateHolder {
  current?: string;
}

/**
 * 每回合工具钳制回调：pi-mcp-adapter 的 syncProxyTool 会在输入收敛时把
 * 网关工具 mcp 主动加回活动集（pi.setActiveTools([...activeTools, "mcp"])），
 * 创建后一次性的过滤拦不住——每回合 before_agent_start 上必须重钳一次。
 * 返回值 = 钳制后重建的实时 base（钳制同步重建 _baseSystemPrompt 并写入
 * state，紧接读取无 await 无并发窗口）；事件的 systemPrompt 是发射前快照，
 * 两回合之间被 adapter 重激活污染时快照已脏——优先用返回值，当回合即净。
 */
export function createQuickPromptExtension(
  holder: QuickTemplateHolder,
  onTurnStart?: () => string | undefined,
): InlineExtension {
  return {
    name: "pi-web-quick-prompt",
    hidden: true,
    factory: (pi: ExtensionAPI): void => {
      pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
        const liveBase = onTurnStart?.();
        const base = liveBase ?? event.systemPrompt ?? "";
        const next = composeQuickSystemPrompt(base, holder.current);
        if (process.env.PI_WEB_LOG_PROMPT_HASH) {
          console.log(`[pi-web] prompt-hash base=${promptHash(base)}(${base.length}) out=${promptHash(next)}(${next.length})${liveBase !== undefined && liveBase !== event.systemPrompt ? " [live]" : ""}`);
        }
        return next === base ? undefined : { systemPrompt: next };
      });
    },
  };
}
