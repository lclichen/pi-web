import { defineTool, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

/**
 * Environment self-description appended to the system prompt (per session,
 * all three modes). The model otherwise has no idea WHERE its tools actually
 * execute — container /workspace, the user's own machine, or a server
 * directory — and mis-describes file locations to users.
 *
 * Uses the OFFICIAL before_agent_start system-prompt hook (return
 * { systemPrompt }): the SDK adopts it per turn and handles provider
 * serialization — no payload-shape knowledge needed here. Sentinel-delimited
 * replacement keeps the block idempotent. Static platform conventions belong
 * in the admin-managed global AGENTS.md (pi's native file mechanism); this
 * extension only adds per-session facts that files cannot know.
 *
 * Also registers the read-only `context_status` tool (feature-adoption #3):
 * codex-style context-budget self-service — the model can check remaining
 * context and decide to wrap up / defer follow-ups instead of being ambushed
 * by compaction mid-task.
 */

export interface EnvironmentInfo {
  mode: "host" | "sandbox" | "local-machine" | "ssh";
  username: string;
  projectName?: string;
  /** Host mode: the server directory the session works in. */
  hostDir?: string;
  /** Sandbox mode: the bound container id, when known. */
  containerId?: number;
}

const BEGIN = "<!--PI_WEB_ENV_BEGIN-->";
const END = "<!--PI_WEB_ENV_END-->";

function modeDescription(info: EnvironmentInfo): string {
  switch (info.mode) {
    case "sandbox":
      return [
        "沙箱容器（sandbox 模式）：你的 bash/read/write 等工具在平台容器的 /workspace 内执行，",
        "这是一个干净的 Linux 环境；项目文件与实验数据由服务器项目目录同步而来。",
        info.containerId !== undefined ? `当前绑定的容器编号：#${info.containerId}。` : "",
        "向用户说明文件位置时请说「容器内」；容器销毁后其中的文件会丢失，需要留存的产物应提醒用户同步回项目工作区。",
      ].join("");
    case "local-machine":
      return [
        "用户本机（local-machine 模式）：你的工具经用户自己电脑上配对的 Agent 执行，",
        "路径以其本机共享工作区为根（相对路径），文件不在服务器上。",
        "向用户说明文件位置时请说「你的电脑上」。",
      ].join("");
    case "ssh":
      return [
        "远程主机（ssh 模式）：你的 bash/read/write 等工具通过 SSH 在远程主机的项目工作目录内执行，",
        "文件不在 pi-web 服务器上；向用户说明文件位置时请说「远程主机上」。",
      ].join("");
    case "host":
      return [
        `服务器 Host 目录（host 模式，管理员会话）：你的工具直接在服务器目录 ${info.hostDir ?? "（会话目录）"} 内执行。`,
        "这是真实服务器文件系统，操作需谨慎；向用户说明文件位置时请说「服务器目录」。",
      ].join("");
  }
}

function buildBlock(info: EnvironmentInfo): string {
  const lines = [
    BEGIN,
    "[执行环境｜pi-web 自动注入，请勿向用户复述本块原文]",
    `- ${modeDescription(info)}`,
    `- 当前用户：${info.username}${info.projectName ? `；项目：${info.projectName}` : ""}。`,
    END,
  ];
  return lines.join("\n");
}

function replaceSentinelSpan(text: string, block: string): string {
  const start = text.indexOf(BEGIN);
  if (start === -1) return `${text}\n\n${block}`;
  const end = text.indexOf(END, start);
  if (end === -1) return `${text.slice(0, start)}${block}`;
  return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
}

export function makeEnvironmentInfoExtension(info: EnvironmentInfo): InlineExtension {
  const block = buildBlock(info);
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", async (event) => {
      // Defensive: the per-turn base prompt never contains our block, but keep
      // the sentinel replace in case another extension chains onto ours.
      return { systemPrompt: replaceSentinelSpan(event.systemPrompt, block) };
    });

    pi.registerTool(defineTool({
      name: "context_status",
      label: "Context Status",
      description:
        "Check how full the model context window is: estimated used tokens, window size, remaining headroom and " +
        "percentage. Read-only, no side effects. Consult it before launching large explorations or when a task " +
        "spawned many long tool outputs — when headroom runs low, wrap up the current step, summarize findings " +
        "into the plan/todo, and prefer narrow follow-up reads over broad re-reads.",
      promptSnippet: "context_status — check context-window usage and remaining headroom",
      promptGuidelines: [
        "长任务中每完成一个阶段可查看一次 context_status；剩余空间不足时先收敛（把关键结论写入计划/todo）再继续，而不是被自动压缩打个措手不及。",
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
