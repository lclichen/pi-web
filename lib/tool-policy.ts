/**
 * 工具策略（P1 模式钳制）：把 tool-manifest 的"操作层 / 远端通道"声明与
 * MCP 服务器声明应用到会话活动工具集。
 *
 * 三层协作（设计见 docs/dev/tool-guardrails-design.md §4）：
 *   · 装配层（初始活动集）：filterToolsForMode 剔除当前模式无执行通道的
 *     声明工具（如远端模式的 powershell）；
 *   · MCP 隔离：mcpServerModePolicy 决定远端模式下哪些服务器被剔除——
 *     HTTP 优先（出网调用不在宿主落地）；stdio/socket 落 pi-web 服务器
 *     本机 = 沙箱逃逸面，默认剔除，管理员可用 piWeb.plane="host" 显式豁免；
 *   · 活动集过滤（含每回合重放）：filterActiveToolsForMode 同时剔除以
 *     <server>_ 命中的直接工具与网关元工具（mcp/mcpScript）——适配器的
 *     syncProxyTool 会在输入收敛时把网关加回活动集（quick 同源问题，
 *     5c5460b2），所以必须每回合重钳。
 *
 * 本模块零副作用（除 readMcpConfig 读配置），便于单元测试。
 */
import { isToolAllowedInMode, manifestFor } from "../pi-config/agent/extensions/amedac-core/src/tool-manifest.ts";
import type { McpTransport, ServerEntry } from "./api-types";
import { detectTransport, readMcpConfig } from "./mcp-config";
import type { SessionMode } from "./session-modes";

/** MCP 网关元工具：能调用任意服务器（含被剔除的），有剔除时必须一并停用。 */
export const MCP_GATEWAY_TOOL_NAMES: ReadonlySet<string> = new Set(["mcp", "mcpScript"]);

const REMOTE_MODES: ReadonlySet<SessionMode> = new Set<SessionMode>(["sandbox", "ssh", "local-machine"]);

/** 远端三模式（工具不在服务器本机执行）。 */
export function isRemoteMode(mode: SessionMode): boolean {
  return REMOTE_MODES.has(mode);
}

export interface ToolExclusion {
  name: string;
  reason: string;
}

/**
 * 声明工具的模式兼容过滤。未在 manifest 声明的工具（MCP direct tools 等）
 * 原样通过——它们的剔除由 filterActiveToolsForMode 按服务器声明处理。
 */
export function filterToolsForMode(
  names: readonly string[],
  mode: SessionMode,
): { allowed: string[]; excluded: ToolExclusion[] } {
  const allowed: string[] = [];
  const excluded: ToolExclusion[] = [];
  for (const name of names) {
    const entry = manifestFor(name);
    if (!entry) {
      allowed.push(name);
      continue;
    }
    if (isToolAllowedInMode(entry, mode)) {
      allowed.push(name);
    } else {
      excluded.push({
        name,
        reason: `工具 ${name} 在 ${mode} 模式没有可用的执行通道（manifest: remote.${mode} = unsupported）`,
      });
    }
  }
  return { allowed, excluded };
}

export interface McpModePolicy {
  excluded: boolean;
  reason?: string;
}

/**
 * 单个 MCP 服务器在某模式下的可见性策略。
 *
 * 默认按传输分流（fail-closed）：
 *   · http：出网调用由 pi-web 服务器发起，MCP 服务在远端，不落地宿主 → 可用；
 *   · stdio / socket：必须在发起方同机 spawn，而适配器在 pi-web 服务器进程
 *     内 → 子进程在宿主执行（沙盒逃逸面）→ 远端模式剔除。
 * 管理员显式声明 `"piWeb": {"plane": "host"}` 可豁免（知情承认风险）；
 * 声明 `plane: "workspace"`（带工作区语义的 MCP）在 P3 前远端不可用。
 */
export function mcpServerModePolicy(entry: ServerEntry, transport: McpTransport, mode: SessionMode): McpModePolicy {
  if (!isRemoteMode(mode)) return { excluded: false };
  const decl = entry.piWeb;
  if (decl?.plane === "host") return { excluded: false };
  if (decl?.plane === "workspace") {
    return {
      excluded: true,
      reason: "MCP 服务器声明为 workspace（操作工作区内容）；远端执行通道（P3）未支持前在远端模式不可用",
    };
  }
  if (transport === "stdio") {
    return {
      excluded: true,
      reason:
        'stdio MCP 在 pi-web 服务器本机执行（沙盒逃逸面）；远端模式默认剔除。确认可信后可用 "piWeb": {"plane": "host"} 显式豁免',
    };
  }
  return { excluded: false };
}

/** 从会话 cwd 的 MCP 配置计算远端模式剔除集合（服务器名）。 */
export function mcpExcludedServers(cwd: string, userId: number, mode: SessionMode): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRemoteMode(mode)) return out;
  let servers: { name: string; entry: ServerEntry; transport: McpTransport }[];
  try {
    servers = readMcpConfig(cwd, { userId }).servers;
  } catch {
    return out; // 配置读失败不制造额外剔除；路径护栏与围栏仍生效
  }
  for (const server of servers) {
    const policy = mcpServerModePolicy(server.entry, server.transport ?? detectTransport(server.entry), mode);
    if (policy.excluded) out.set(server.name, policy.reason ?? "远端模式不可用");
  }
  return out;
}

/** 工具名是否属于某 MCP 服务器（整段 `<server>_` 前缀，服务器名可含下划线）。 */
export function isToolOfServer(toolName: string, serverName: string): boolean {
  return toolName.startsWith(`${serverName}_`);
}

export interface ActiveToolFilterOptions {
  mode: SessionMode;
  /** 当前模式被剔除的 MCP 服务器名 → 原因。 */
  excludedMcpServers: ReadonlyMap<string, string>;
}

/**
 * 活动集过滤：声明工具按模式兼容性剔除；MCP 服务器被剔除时，其直接工具
 * 与网关元工具一并剔除。返回保持输入顺序的允许集 + 剔除说明。
 */
export function filterActiveToolsForMode(
  names: readonly string[],
  opts: ActiveToolFilterOptions,
): { allowed: string[]; excluded: ToolExclusion[] } {
  const declared = filterToolsForMode(names, opts.mode);
  if (opts.excludedMcpServers.size === 0) return declared;
  const allowed: string[] = [];
  const excluded = [...declared.excluded];
  for (const name of declared.allowed) {
    if (MCP_GATEWAY_TOOL_NAMES.has(name)) {
      excluded.push({ name, reason: `存在被剔除的 MCP 服务器（${[...opts.excludedMcpServers.keys()].join(", ")}），网关元工具一并停用` });
      continue;
    }
    let hit = false;
    for (const [server, reason] of opts.excludedMcpServers) {
      if (isToolOfServer(name, server)) {
        excluded.push({ name, reason });
        hit = true;
        break;
      }
    }
    if (!hit) allowed.push(name);
  }
  return { allowed, excluded };
}
