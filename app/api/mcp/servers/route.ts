import { NextResponse } from "next/server";
import { createMcpServer } from "@/lib/mcp-config";
import type { ConfigScope, ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: unknown): ConfigScope {
  return v === "global" ? "global" : "project";
}

// POST /api/mcp/servers  body: { cwd, scope?, name, entry }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      cwd?: string;
      scope?: string;
      name?: string;
      entry?: ServerEntry;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!body.entry || typeof body.entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }
    if (!body.entry.command && !body.entry.url) {
      return NextResponse.json(
        { error: "entry must have either command or url" },
        { status: 400 },
      );
    }
    const scope = readScope(body.scope);
    try {
      createMcpServer(body.cwd, scope, body.name.trim(), body.entry);
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
