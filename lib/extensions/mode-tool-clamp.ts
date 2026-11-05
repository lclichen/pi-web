import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * 远程模式每回合工具钳制（P1 工具护栏）。
 *
 * pi-mcp-adapter 的 syncProxyTool 会在输入收敛时把网关元工具 mcp/mcpScript
 * 主动加回活动集——创建后一次性的过滤拦不住（quick 同源问题，见
 * lib/quick-prompt.ts 的注释与 5c5460b2）。存在被剔除的 MCP 服务器时，
 * 每回合 before_agent_start 重放一次钳制。
 *
 * 返回值语义与 quick 一致：事件的 systemPrompt 是发射前快照，两回合之间
 * 被 adapter 重激活污染时快照已脏；回调返回钳制后重建的实时 base 时优先
 * 使用返回值，当回合即净。没有发生钳制（返回 undefined）则不改提示词。
 */
export function createModeToolClampExtension(
  onTurnStart: () => string | undefined,
): InlineExtension {
  return {
    name: "pi-web-mode-tool-clamp",
    hidden: true,
    factory: (pi: ExtensionAPI): void => {
      pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
        const liveBase = onTurnStart();
        if (liveBase !== undefined && liveBase !== event.systemPrompt) {
          return { systemPrompt: liveBase };
        }
        return undefined;
      });
    },
  };
}
