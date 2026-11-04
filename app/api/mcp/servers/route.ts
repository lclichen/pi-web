import { NextResponse } from "next/server";
import { createMcpServer } from "@/lib/mcp-config";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
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
    // 控制面隔离（2026-11-03 P0）：项目级 stdio MCP 在 pi-web 服务器进程内
    // 启动，普通用户不可用；http MCP 不受限。
    if ((scope === "project" || scope === "user") && !guard.isAdmin && body.entry.command) {
      return NextResponse.json(
        {
          error:
            "项目级 stdio MCP 会在 pi-web 服务器进程内启动，普通用户不可用。请改用 http MCP，或联系管理员在全局配置中添加。",
        },
        { status: 403 },
      );
    }
    try {
      createMcpServer(guard.cwd, scope, body.name.trim(), body.entry, guard.userId);
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
