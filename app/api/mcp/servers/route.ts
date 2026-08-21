import { NextResponse } from "next/server";
import { createMcpServer } from "@/lib/mcp-config";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import type { ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// POST /api/mcp/servers  body: { cwd|projectId, scope?, name, entry }
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
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
      return NextResponse.json(
        { error: "entry must have command, url, or socket" },
        { status: 400 },
      );
    }
    const guard = guardMcpRequest(req, body, { mutating: true });
    if (!guard.ok) return guard.response;
    const scope = body.scope === "global" ? "global" : "project";
    try {
      createMcpServer(guard.cwd, scope, body.name.trim(), body.entry);
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
