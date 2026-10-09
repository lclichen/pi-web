import { NextResponse } from "next/server";
import { readMcpConfig } from "@/lib/mcp-config";
import { resolveConfigCwdSync } from "@/lib/config-cwd";

export const dynamic = "force-dynamic";

// GET /api/mcp?cwd=|projectId= — merged project+global config document.
// MERGE-NOTE(upgrade/1.0): upstream replaced this route with its built-in MCP
// settings panel API (enabled/exposure semantics over mcp-config-file /
// mcp-config-read). Dev keeps the pi-mcp-adapter document semantics
// (ServerEntry: disabled/directTools) — the fork's MCP stack reads the same
// adapter config, so the route stays a thin read over readMcpConfig().
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
  try {
    return NextResponse.json(readMcpConfig(dir.cwd));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
