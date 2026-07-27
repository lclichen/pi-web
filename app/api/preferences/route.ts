import { NextResponse } from "next/server";
import { readPreferences, writePreferences } from "@/lib/preferences-service";
import type { WebPreferences } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// GET /api/preferences?cwd=
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  return NextResponse.json(readPreferences(cwd));
}

// PUT /api/preferences  body: { cwd, mcpEnabled, subagentsEnabled }
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string } & Partial<WebPreferences>;
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const prefs: WebPreferences = {
      mcpEnabled: body.mcpEnabled ?? true,
      subagentsEnabled: body.subagentsEnabled ?? true,
      labVerifyEnabled: body.labVerifyEnabled ?? true,
    };
    writePreferences(body.cwd, prefs);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
