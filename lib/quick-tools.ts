/**
 * 快速会话工具白名单的纯函数层（零重依赖，便于单测）。
 *
 * 两个维度（并集语义）：
 * - servers：整服务器授权（模板旧字段 mcpServers）——该服务器所有
 *   `<server>_<tool>` 直接工具；
 * - tools：工具级授权（模板新字段 mcpTools）——精确的适配器工具名
 *   `<server>_<tool>`，与子智能体 `ext:pi-mcp-adapter/<server>_<tool>` 一致。
 *
 * 空/缺省 = 封闭世界（零 MCP 工具），不是"全部允许"：快速会话没有工作区，
 * 模板白名单是唯一放行面。
 */

export interface QuickToolAllowlist {
  /** Whole-server grants: every tool whose name starts with `<server>_`. */
  servers: string[];
  /** Exact adapter tool names (`<server>_<tool>`). */
  tools: string[];
}

/** Normalize a template/quick option into the runtime allowlist shape. */
export function quickToolAllowlist(source?: {
  mcpServers?: string[];
  mcpTools?: string[];
}): QuickToolAllowlist | undefined {
  if (!source) return undefined;
  const clean = (values?: string[]): string[] =>
    [...new Set((values ?? []).map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
  return {
    servers: clean(source.mcpServers),
    tools: clean(source.mcpTools),
  };
}

/** Whether a registered tool is inside the quick closed world. */
export function quickToolAllowed(toolName: string, allowlist?: QuickToolAllowlist): boolean {
  if (!allowlist) return false;
  if (allowlist.tools.includes(toolName)) return true;
  // 整段匹配 `<server>_`：服务器名可含下划线（mcd_tool_1 的工具是
  // mcd_tool_1_now-time-info），截到第一个下划线会错切。
  return allowlist.servers.some((server) => server.length > 0 && toolName.startsWith(server + "_"));
}

/** Filter registered tool names down to the quick allowlist (deduped). */
export function quickToolNames(toolNames: string[], allowlist?: QuickToolAllowlist): string[] {
  if (!allowlist) return [];
  return [...new Set(toolNames)].filter((name) => quickToolAllowed(name, allowlist));
}

/**
 * Map tool-level allowlist entries back to their server names, using the
 * KNOWN configured server names (pool) instead of splitting on underscores.
 * Longest matching server wins, so `mcd_tool_1` beats a hypothetical `mcd`.
 */
export function serversForQuickTools(toolNames: string[], knownServers: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tool of toolNames) {
    let match: string | null = null;
    for (const server of knownServers) {
      if (!server || !tool.startsWith(server + "_")) continue;
      if (!match || server.length > match.length) match = server;
    }
    if (match && !seen.has(match)) {
      seen.add(match);
      out.push(match);
    }
  }
  return out;
}
