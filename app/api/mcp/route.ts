import { NextResponse } from "next/server";
import { readMcpConfig } from "@/lib/mcp-config";

export const dynamic = "force-dynamic";

// GET /api/mcp?cwd=  — merged project+global config document
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  try {
    return NextResponse.json(readMcpConfig(cwd));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
