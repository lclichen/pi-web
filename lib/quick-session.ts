import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { quickHomeDir } from "./mode-homes";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { deploymentQuickMcpPath } from "./quick-mcp";

import type { QuickTemplate } from "./quick-templates";

/**
 * 快速会话工作区（2026-10-14 修订：按模板+版本共享）。
 *
 * 目录：data/quick-homes/u{id}/t-<templateId>-<hash>/——同模板同内容版本的
 * 所有会话共享一个工作区（配置相同，无需隔离）；模板内容变更 → hash 变 →
 * 新目录（旧目录成为上一个版本的归档，可整体清理）。
 *
 * 目录内：
 *   - .pi/mcp.json：部署级 quick MCP（scope=quick，dataDir/mcp-quick.json）
 *     物化——项目作用域语义使其只在 quick 会话可见。
 *   - .pi/quick-template.json：模板快照（含 hash）——从工作区即可回查
 *     "这个会话用的是哪个模板哪个版本"（前端显示；readQuickTemplateSnapshot
 *     兼容读任意目录，旧会话目录同样可查）。
 *
 * meta 只记 quickDir（slug）；路径由 quickSessionDir(userId, slug) 重建。
 * 旧会话（无 slug / 共享 home）回落 quickHomeDir，行为不变。
 */

export interface QuickTemplateSnapshot {
  id: string;
  name: string;
  /** 内容哈希（8 hex）：systemPrompt+mcpServers+model(+tools) 的指纹。 */
  hash: string;
  systemPrompt: string;
  mcpServers: string[];
  model?: { provider: string; modelId: string };
  capturedAt: string;
}

export function quickTemplateHash(template: {
  systemPrompt: string;
  mcpServers?: string[];
  model?: { provider: string; modelId: string };
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt: template.systemPrompt,
        mcpServers: [...(template.mcpServers ?? [])].sort(),
        model: template.model ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 8);
}

export function snapshotTemplate(template: QuickTemplate): QuickTemplateSnapshot {
  return {
    id: template.id,
    name: template.name,
    hash: quickTemplateHash(template),
    systemPrompt: template.systemPrompt,
    mcpServers: [...(template.mcpServers ?? [])],
    ...(template.model ? { model: template.model } : {}),
    capturedAt: new Date().toISOString(),
  };
}

/** 工作区 slug：模板 id + 内容 hash（同版本恒等 → 目录复用）。 */
export function quickWorkspaceSlug(template: QuickTemplate): string {
  const safeId = template.id.replace(/[^\w.-]+/g, "-").slice(0, 40) || "default";
  return `${safeId}-${quickTemplateHash(template)}`;
}

export function quickSessionDir(userId: number, slug: string): string {
  return join(quickHomeDir(userId), `q-${slug}`);
}

export function snapshotPath(dir: string): string {
  return join(dir, ".pi", "quick-template.json");
}

export function readQuickTemplateSnapshot(dir: string): QuickTemplateSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(snapshotPath(dir), "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const s = parsed as Partial<QuickTemplateSnapshot>;
    if (typeof s.id !== "string" || typeof s.name !== "string" || typeof s.hash !== "string") return null;
    return {
      id: s.id,
      name: s.name,
      hash: s.hash,
      systemPrompt: typeof s.systemPrompt === "string" ? s.systemPrompt : "",
      mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers.filter((x): x is string => typeof x === "string") : [],
      ...(s.model && typeof s.model.provider === "string" && typeof s.model.modelId === "string"
        ? { model: s.model as { provider: string; modelId: string } }
        : {}),
      capturedAt: typeof s.capturedAt === "string" ? s.capturedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeQuickTemplateSnapshot(dir: string, snapshot: QuickTemplateSnapshot): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(snapshotPath(dir), JSON.stringify(snapshot, null, 2), "utf8");
}

/**
 * 配置级 MCP 过滤：工作区 .pi/mcp.json 只写模板白名单内的服务器。
 * 从全局 mcp.json 拉取白名单内的服务器定义（模板可引用全局 MCP）。
 *
 * 注意：这只约束 adapter 的会话级初始化（ctx.cwd）——direct tools 走
 * adapter 的 earlyConfig（进程 cwd，无 shadow）仍会注册，所以工具层
 * 的 quickToolSet 封闭世界过滤不可省（lib/rpc-manager.ts，
 * 2026-10-16 实测：只靠配置级过滤时全局 MCP 工具泄漏进快速会话）。
 */
function writeWorkspaceMcp(userId: number, dir: string, allowlist: string[] | undefined): void {
  const readMcpFromFile = (path: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const servers = (parsed as { mcpServers?: unknown }).mcpServers;
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          return servers as Record<string, unknown>;
        }
      }
    } catch {
      /* 文件不存在或格式错——忽略 */
    }
    return {};
  };

  // 候选池：部署级 quick MCP + 全局 agent mcp.json（同名时 quick 优先）
  const quickServers = readMcpFromFile(deploymentQuickMcpPath());
  const globalServers = readMcpFromFile(join(getAgentDir(), "mcp.json"));
  const pool = { ...globalServers, ...quickServers };

  // 写入工作区 .pi/mcp.json（最高优先级层）：
  // - 白名单内 → 完整配置（启用）
  // - 白名单外但池中存在 → { disabled: true } 遮蔽全局（pi-mcp-adapter 的
  //   优先级链：.pi/mcp.json 最高，同名条目覆盖所有低层来源）
  // - 池中无此名 → 不写（不存在的服务器无遮蔽意义）
  const filtered: Record<string, unknown> = {};
  const allow = new Set(allowlist ?? []);
  for (const [name, config] of Object.entries(pool)) {
    if (allow.has(name)) {
      filtered[name] = config;
    } else {
      filtered[name] = { disabled: true };
    }
  }

  const target = join(dir, ".pi", "mcp.json");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  // settings.disableProxyTool：quick 封闭世界只经直接工具（<server>_ 前缀）
  // 暴露白名单服务器；网关元工具 mcp/mcpScript 不该出现——adapter 的
  // syncProxyTool 每回合可能把它加回活动集，配置层先让它自我抑制。
  writeFileSync(
    target,
    JSON.stringify(
      {
        settings: { disableProxyTool: true },
        mcpServers: filtered,
      },
      null,
      2,
    ),
    "utf8",
  );
}
/**
 * 取得（或复用）快速会话工作区：目录名 = 模板 id + 内容 hash——同模板同
 * 版本的所有会话共享；首次进入时物化部署级 quick MCP 并写模板快照。
 */
export function ensureQuickSessionWorkspace(
  userId: number,
  template: QuickTemplate | undefined,
): { dir: string; slug: string } {
  if (!template) {
    // 无模板（理论上不会：默认模板恒存在）——共享 home 兜底
    return { dir: quickHomeDir(userId), slug: "" };
  }
  const slug = quickWorkspaceSlug(template);
  const dir = quickSessionDir(userId, slug);
  if (!existsSync(dir)) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
  }
  // 配置级 MCP 过滤（2026-10-14：替代 syncQuickMcpConfig 的全量物化）：
  // 只写模板白名单内的服务器——MCP 适配器只连白名单，工具列表自然正确。
  writeWorkspaceMcp(userId, dir, template.mcpServers);
  if (!readQuickTemplateSnapshot(dir)) {
    writeQuickTemplateSnapshot(dir, snapshotTemplate(template));
  }
  return { dir, slug };
}
