/**
 * 提示词一致性：钉住（pin）与漂移告警（2026-10-19 研究结论的落地）。
 *
 * 背景：供应商侧前缀缓存按逐字节前缀命中，系统提示词位于每次请求最前端，
 * 一个字节的变化使全部历史的缓存失效。SDK 的 _baseSystemPrompt 会在
 * setActiveToolsByName / resources_discover / reload 时重建，工具段顺序
 * = 激活序（注册时序），且扩展（pi-mcp-adapter）会在两回合之间重激活
 * 工具——都是缓存打断源。rpc-manager 侧已做排序化/每回合钳制把"不该变"
 * 的变化消除；本模块负责把"确实变了"的事实变成可观测：
 *
 * - createPromptConsistencyExtension 注册在工厂列表**末尾**——
 *   before_agent_start 钩子是顺序链式的（后一个收到前一个的输出，见
 *   extension runner），末位扩展看到的正是最终发给模型的提示词。
 * - wrapper.observePrompt 首观测钉住哈希（持久化到 session meta，跨
 *   重启延续），之后每回合比对，漂移即 console.warn 带归因
 *   （工具数/长度变化，或同工具数不同字节=顺序/文案漂移）。
 * - 用户显式动作（切工具预设/切模板）造成的漂移是合法的——告警一次、
 *   重钉新状态，不重复刷屏。
 */

import { createHash } from "crypto";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** 钉在 session meta 里的观测值（跨重启延续）。 */
export interface PromptPin {
  hash: string;
  len: number;
  tools: number;
}

export function hashPrompt(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** 统计提示词 "Available tools:" 段的工具行数（漂移归因用；解析失败返回 -1）。 */
export function countPromptTools(prompt: string): number {
  const section = prompt.match(/Available tools:\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/);
  if (!section) return -1;
  const lines = section[1].split(/\r?\n/).filter((line) => line.startsWith("- "));
  return lines.length;
}

/** 末位钉住扩展：报告最终合成提示词的哈希/长度/工具数。 */
export function createPromptConsistencyExtension(
  report: (hash: string, len: number, tools: number) => void,
): InlineExtension {
  return {
    name: "pi-web-prompt-pin",
    hidden: true,
    factory: (pi: ExtensionAPI): void => {
      pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
        const text = event.systemPrompt ?? "";
        report(hashPrompt(text), text.length, countPromptTools(text));
        return undefined;
      });
    },
  };
}

/** 漂移告警文案（归因：工具数变化 > 同数不同字节=顺序/文案 > 仅长度）。 */
export function describePromptDrift(pinned: PromptPin, current: PromptPin): string {
  if (pinned.tools !== current.tools) {
    return `tools ${pinned.tools}→${current.tools}, len ${pinned.len}→${current.len}`;
  }
  if (pinned.len !== current.len) {
    return `same tool count, len ${pinned.len}→${current.len}`;
  }
  return `same size (${current.len}B), content/order drifted`;
}
