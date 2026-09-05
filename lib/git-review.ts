import {
  Agent,
  type AgentOptions,
} from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * One-shot git insights from the session's own model ("主会话模型"), mirroring
 * the session-title shadow-agent pattern: a temporary Agent reusing the source
 * session's provider plumbing (model / api key / stream fn) with an EMPTY
 * message history and NO tools — a pure completion, so it cannot touch the
 * project. Used by /api/git/review for code review and commit-message
 * generation from the working-tree diff.
 */

const INSIGHT_TIMEOUT_MS = 180_000;
const MAX_DIFF_CHARS = 60_000;

export type GitInsightMode = "review" | "commit-message";

export interface GitInsightInput {
  mode: GitInsightMode;
  diff: string;
  /** Changed-file summary (path + status letters), also fed to the model. */
  fileSummary: string;
  /** Recent commit subjects — style reference for commit messages. */
  recentSubjects: string[];
  branch?: string | null;
}

export interface GitInsightResult {
  text: string;
  usage?: { input: number; output: number; total: number };
}

const REVIEW_SYSTEM = [
  "你是一名严谨的代码审查员（code reviewer）。你会收到当前工作区相对 HEAD 的统一 diff。",
  "请用中文输出结构化审查意见，格式：",
  "1. 概览：一两句话说明这批改动的意图与整体质量。",
  "2. 问题清单：按严重性编号（P0 阻断 / P1 重要 / P2 建议），每条给出 文件:行号（能定位时）、问题描述、修改建议。",
  "3. 测试建议：这批改动值得补充的验证点。",
  "没有问题时明确说「未发现明显问题」，不要为了凑数硬找。不要输出与审查无关的寒暄。",
].join("\n");

const COMMIT_MSG_SYSTEM = [
  "你是一名提交信息撰写助手。根据统一 diff 写一条 git 提交信息，要求：",
  "- 第一行：不超过 50 个字符的祈使句主题行（conventional commits 风格可加类型前缀，如 fix:/feat:），语言与仓库近期提交保持一致（默认跟随 diff 注释语言，中文仓库用中文）。",
  "- 若改动较复杂，空一行后给 3 行以内的正文说明动机。",
  "- 只输出提交信息本身，不要代码块围栏、不要解释、不要签名。",
].join("\n");

function buildPrompt(input: GitInsightInput): string {
  const trim = (s: string) => (s.length > MAX_DIFF_CHARS
    ? `${s.slice(0, Math.floor(MAX_DIFF_CHARS * 0.7))}\n\n…（diff 过长，中段省略）…\n\n${s.slice(-Math.floor(MAX_DIFF_CHARS * 0.3))}`
    : s);
  const style = input.recentSubjects.length > 0
    ? `近期提交（风格参考）：\n${input.recentSubjects.map((s) => `- ${s}`).join("\n")}\n\n`
    : "";
  const head = [
    input.branch ? `分支：${input.branch}` : null,
    `改动文件：\n${input.fileSummary}`,
  ].filter(Boolean).join("\n");
  return `${head}\n\n${style}统一 diff：\n\`\`\`diff\n${trim(input.diff) || "（无文本 diff —— 可能只有未跟踪文件）"}\n\`\`\``;
}

export function buildGitInsightAgentOptions(source: Agent): AgentOptions {
  const state = source.state;
  return {
    initialState: {
      systemPrompt: state.systemPrompt,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      tools: [],
      messages: [],
    },
    convertToLlm: source.convertToLlm,
    transformContext: source.transformContext,
    streamFn: source.streamFunction,
    getApiKey: source.getApiKey,
    onPayload: source.onPayload,
    onResponse: source.onResponse,
    sessionId: source.sessionId,
    thinkingBudgets: source.thinkingBudgets,
    transport: source.transport,
    maxRetryDelayMs: source.maxRetryDelayMs,
    toolExecution: source.toolExecution,
  };
}

export async function generateGitInsight(
  source: AgentSession,
  input: GitInsightInput,
): Promise<GitInsightResult> {
  const sourceAgent = source.agent;
  await sourceAgent.waitForIdle();

  const options = buildGitInsightAgentOptions(sourceAgent);
  options.initialState!.systemPrompt = input.mode === "review" ? REVIEW_SYSTEM : COMMIT_MSG_SYSTEM;

  const temporaryAgent = new Agent(options);
  const runPromise = temporaryAgent.prompt(buildPrompt(input));
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          temporaryAgent.abort();
          reject(new Error(input.mode === "review" ? "代码审查超时" : "提交信息生成超时"));
        }, INSIGHT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    temporaryAgent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  for (let i = temporaryAgent.state.messages.length - 1; i >= 0; i--) {
    const message = temporaryAgent.state.messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "模型请求失败");
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) continue;
    // commit-message mode: strip a wrapping code fence if the model added one.
    const cleaned = input.mode === "commit-message" ? stripFence(text) : text;
    return {
      text: cleaned,
      ...(message.usage ? {
        usage: {
          input: message.usage.input,
          output: message.usage.output,
          total: message.usage.totalTokens,
        },
      } : {}),
    };
  }
  throw new Error("模型没有返回内容");
}

function stripFence(text: string): string {
  const fenced = text.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  return text;
}
