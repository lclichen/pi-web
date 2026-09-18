/**
 * context_status — read-only context-budget self-service (codex's
 * get_context_remaining counterpart). Portable: only needs
 * ctx.getContextUsage(), so it rides amedac-core for BOTH the pi CLI and
 * pi-web (environment-info keeps only its mode-specific prompt block).
 */
import { defineTool, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export function makeContextStatusExtension(): InlineExtension {
  return (pi: ExtensionAPI): void => {
    pi.registerTool(defineTool({
      name: "context_status",
      label: "Context Status",
      description:
        "Check how full the model context window is: estimated used tokens, window size, remaining headroom and " +
        "percentage. Read-only, no side effects. Consult it before launching large explorations or when a task " +
        "spawned many long tool outputs — when headroom runs low, wrap up the current step, summarize findings " +
        "into the plan/todo, and prefer narrow follow-up reads over broad re-reads.",
      promptSnippet: "context_status — check context-window usage and remaining headroom",
      // 中文版备查：长任务中每完成一个阶段可查看一次 context_status；剩余空间不足时
      // 先收敛（把关键结论写入计划/todo）再继续，而不是被自动压缩打个措手不及。
      promptGuidelines: [
        "On long tasks, check context_status once per completed phase; when headroom runs low, converge first (persist key conclusions into the plan/todo) before continuing instead of being ambushed by auto-compaction.",
      ],
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const usage = ctx.getContextUsage();
        if (!usage || usage.tokens === null || !usage.contextWindow) {
          return {
            content: [{ type: "text" as const, text: "Context usage is currently unknown (e.g. right after compaction, before the next model response)." }],
            details: { known: false },
          };
        }
        const remaining = Math.max(0, usage.contextWindow - usage.tokens);
        const remainingPercent = usage.percent === null ? null : Math.max(0, 100 - usage.percent);
        return {
          content: [{
            type: "text" as const,
            text:
              `Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens ` +
              `(${usage.percent ?? "?"}% used) — ${remaining.toLocaleString()} tokens headroom (~${remainingPercent ?? "?"}%).` +
              (usage.percent !== null && usage.percent >= 80
                ? " Headroom is LOW: wrap up the current step, persist key findings (plan/todo), and keep further reads narrow."
                : ""),
          }],
          details: { known: true, tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent, remaining, remainingPercent },
        };
      },
    }));
  };
}
