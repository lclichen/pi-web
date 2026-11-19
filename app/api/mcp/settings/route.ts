import { NextResponse } from "next/server";
import { writeMcpSettings } from "@/lib/mcp-config";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import { withProjectConfigWriteLockFor, ProjectConfigLockBusyError } from "@/lib/project-config-lock";
import type { McpSettings } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// PUT /api/mcp/settings  body: { cwd|projectId, scope?, settings }
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      cwd?: string;
      projectId?: string;
      scope?: string;
      settings?: McpSettings;
    };
    if (!body.settings || typeof body.settings !== "object") {
      return NextResponse.json({ error: "settings required" }, { status: 400 });
    }
    const guard = guardMcpRequest(req, body, { mutating: true });
    if (!guard.ok) return guard.response;
    const scope: "global" | "project" = body.scope === "global" ? "global" : "project";
    try {
      // 项目 scope 写 <project home>/.pi/mcp.json 的 settings 块 → 共享项目
      // 写锁（ADR-0004 §4.2）；global 写数据目录，不加锁。
      const settings = body.settings;
      await withProjectConfigWriteLockFor(scope === "project" ? guard.projectId : undefined, async () => {
        writeMcpSettings(guard.cwd, scope, settings);
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
