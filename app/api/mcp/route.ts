import { NextResponse } from "next/server";
import { readMcpConfig } from "@/lib/mcp-config";
import { resolveConfigCwdSync } from "@/lib/config-cwd";

export const dynamic = "force-dynamic";

// GET /api/mcp?cwd=|projectId= — merged project+global config document.
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
