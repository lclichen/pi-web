import { NextResponse } from "next/server";
import { writeMcpSettings } from "@/lib/mcp-config";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import type { McpSettings } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// PUT /api/mcp/settings  body: { cwd|projectId, scope?, settings }
export async function PUT(req: Request) {
  try {
    const body = await req.json() as {
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
      writeMcpSettings(guard.cwd, scope, body.settings);
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 409 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
