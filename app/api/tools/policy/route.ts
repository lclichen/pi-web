import { NextResponse } from "next/server";
import { resolveConfigCwdSync } from "@/lib/config-cwd";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listProjects, projectHome } from "@/lib/projects";
import { readMcpConfig } from "@/lib/mcp-config";
import { isRemoteMode, mcpServerModePolicy } from "@/lib/tool-policy";
import { normalizePolicyPath } from "@/lib/extensions/path-guard";
import { TOOL_MANIFEST } from "@/lib/extensions/tool-manifest";
import type { SessionMode } from "@/lib/session-modes";

export const dynamic = "force-dynamic";

/**
 * 设置 → 策略 → 工具护栏（P2）：工具操作层声明的只读视图。
 *
 * 数据面：
 *   · tools  — tool-manifest 全量声明（plane/risk/pathParams/commandParams/
 *              remote 三通道/origin），前端渲染模式矩阵；
 *   · mcp    — 当前项目 MCP 服务器的传输方式 + piWeb 声明 + 本模式下是否
 *              被剔除（与 rpc-manager 装配时的判定共用 lib/tool-policy）。
 *
 * 只读：MCP 声明编辑走现有 MCP 配置（mcp.json 的 "piWeb" 块）。身份与
 * 目录门禁与 /api/policy 同源（isApiRequestAllowed + requireUserIdentity）。
 */

/** cwd 对应的项目模式；不在项目注册表内 = Host 目录。 */
function resolveProjectMode(cwd: string, ownerId: number): SessionMode {
  for (const project of listProjects(ownerId)) {
    if (normalizePolicyPath(projectHome(project)) === normalizePolicyPath(cwd)) return project.mode;
  }
  return "host";
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });

  const ownerId = identity.session.user.id;
  const mode = resolveProjectMode(dir.cwd, ownerId);

  let mcpServers: {
    name: string;
    transport: string;
    disabled: boolean;
    declaration: unknown;
    excludedInMode: boolean;
    reason?: string;
  }[] = [];
  try {
    const doc = readMcpConfig(dir.cwd, { userId: ownerId });
    mcpServers = doc.servers.map((server) => {
      const policy = mcpServerModePolicy(server.entry, server.transport, mode);
      return {
        name: server.name,
        transport: server.transport,
        disabled: server.disabled,
        declaration: server.entry.piWeb ?? null,
        excludedInMode: policy.excluded,
        ...(policy.reason ? { reason: policy.reason } : {}),
      };
    });
  } catch {
    // 配置读失败不阻断全局声明视图。
  }

  return NextResponse.json({
    cwd: dir.cwd,
    mode,
    remote: isRemoteMode(mode),
    tools: TOOL_MANIFEST,
    mcp: mcpServers,
  });
}
