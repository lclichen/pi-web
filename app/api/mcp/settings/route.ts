import { NextResponse } from "next/server";
import { writeMcpSettings } from "@/lib/mcp-config";
import type { ConfigScope, McpSettings } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// PUT /api/mcp/settings  body: { cwd, scope?, settings }
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as {
      cwd?: string;
      scope?: string;
      settings?: McpSettings;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.settings || typeof body.settings !== "object") {
      return NextResponse.json({ error: "settings required" }, { status: 400 });
    }
    const scope: ConfigScope = body.scope === "global" ? "global" : "project";
    try {
      writeMcpSettings(body.cwd, scope, body.settings);
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
