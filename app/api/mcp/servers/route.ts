import { NextResponse } from "next/server";
import { createMcpServer } from "@/lib/mcp-config";
import { getOwnedProject } from "@/lib/projects";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import { withProjectConfigWriteLockFor, ProjectConfigLockBusyError } from "@/lib/project-config-lock";
import type { ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// POST /api/mcp/servers  body: { cwd|projectId, scope?, name, entry }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      cwd?: string;
      projectId?: string;
      scope?: string;
      name?: string;
      entry?: ServerEntry;
    };
    if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!body.entry || typeof body.entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }
    if (!body.entry.command && !body.entry.url && !body.entry.socket) {
      return NextResponse.json({ error: "entry must have command, url, or socket" }, { status: 400 });
    }
    const guard = guardMcpRequest(req, body, { mutating: true });
    if (!guard.ok) return guard.response;
    const scope =
      body.scope === "global" || body.scope === "quick" || body.scope === "user" ? body.scope : "project";
    // 控制面隔离（2026-11-03 P0）：普通用户的项目级 stdio MCP 默认会在
    // pi-web 服务器进程内启动。唯一例外是 local-machine 项目显式声明
    // piWeb.plane="workspace"：该条目由 relay MCP host 在用户配对机器上
    // 执行，不在控制面落地。用户 scope 没有机器绑定，仍拒绝。
    const project =
      scope === "project" && guard.projectId
        ? getOwnedProject(guard.projectId, guard.userId)
        : undefined;
    const relayWorkspaceStdio =
      scope === "project" &&
      project?.mode === "local-machine" &&
      body.entry.piWeb?.plane === "workspace";
    if ((scope === "project" || scope === "user") && !guard.isAdmin && body.entry.command && !relayWorkspaceStdio) {
      return NextResponse.json(
        {
          error:
            "项目级 stdio MCP 默认会在 pi-web 服务器进程内启动，普通用户不可用。本机模式项目可改用 http MCP，或在条目的 piWeb.plane 声明 \"workspace\" 让它在你的配对机器上运行。",
        },
        { status: 403 },
      );
    }
    try {
      // 项目 scope 写 <project home>/.pi/mcp.json → 共享项目写锁（ADR-0004
      // §4.2）；全局/用户/quick scope 写数据目录，不加锁。
      const serverName = body.name.trim();
      const entry = body.entry;
      await withProjectConfigWriteLockFor(scope === "project" ? guard.projectId : undefined, async () => {
        createMcpServer(guard.cwd, scope, serverName, entry, guard.userId);
      });
      return NextResponse.json({ success: true });
    } catch (e) {
      if (e instanceof ProjectConfigLockBusyError) {
        return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
      }
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
