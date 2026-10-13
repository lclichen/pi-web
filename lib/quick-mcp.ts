import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, quickHomeDir } from "./mode-homes";

/**
 * 部署级"快速会话专用"MCP 配置（2026-10-13）。
 *
 * 文件：<dataDir>/mcp-quick.json，结构与 mcp.json 一致（{mcpServers: {...}}），
 * 管理员手工维护。quick 会话创建时（agent/new 的 quick 分支）把它的条目
 * 物化进该用户的 quick home .pi/mcp.json——readMcpConfig 的 project-scope
 * 语义使这些服务器**只在 quick 会话可见**（其它模式的 cwd 各不相同，读不到
 * quick home 下的这份文件）。
 *
 * 合并策略：部署级覆盖同名服务器；用户在 quick home 自加的其它条目保留；
 * 幂等（结果不变则不写，mtime 稳定）。文件缺失或形状不对 = 整体忽略，
 * 绝不破坏现状。
 */

export function deploymentQuickMcpPath(): string {
  return join(dataDir(), "mcp-quick.json");
}

/** 读取部署级条目；缺失/畸形返回空（调用方据此短路）。 */
function readDeploymentServers(): Record<string, unknown> | null {
  const path = deploymentQuickMcpPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return null;
    return servers as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 把部署级 quick MCP 条目物化进用户 quick home（幂等；quick 会话创建时调用）。 */
export function syncQuickMcpConfig(userId: number): void {
  const deployment = readDeploymentServers();
  if (!deployment || Object.keys(deployment).length === 0) return;

  const piDir = join(quickHomeDir(userId), ".pi");
  const target = join(piDir, "mcp.json");
  let doc: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    const existing: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
      doc = existing as typeof doc;
    }
  } catch {
    // 新建（或既有文件损坏——部署级内容照常写入）
  }

  const merged = { ...(doc.mcpServers ?? {}), ...deployment };
  if (JSON.stringify(doc.mcpServers ?? {}) === JSON.stringify(merged)) return;

  mkdirSync(piDir, { recursive: true });
  writeFileSync(target, JSON.stringify({ ...doc, mcpServers: merged }, null, 2), "utf8");
}
