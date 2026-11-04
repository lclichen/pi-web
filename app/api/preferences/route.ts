import { NextResponse } from "next/server";
import { readPreferences, writePreferences } from "@/lib/preferences-service";
import type { WebPreferences } from "@/lib/api-types";
import { resolveConfigCwdSync } from "@/lib/config-cwd";

export const dynamic = "force-dynamic";

// GET /api/preferences?cwd=&projectId=
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const resolved = resolveConfigCwdSync(req, {
    projectId: searchParams.get("projectId"),
    cwd: searchParams.get("cwd"),
  });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  return NextResponse.json(readPreferences(resolved.cwd));
}

// PUT /api/preferences  body: { cwd|projectId, mcpEnabled, subagentsEnabled, labVerifyEnabled }
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string; projectId?: string } & Partial<WebPreferences>;
    const resolved = resolveConfigCwdSync(req, {
      projectId: body.projectId ?? null,
      cwd: body.cwd ?? null,
    });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    const prefs: WebPreferences = {
      mcpEnabled: body.mcpEnabled ?? true,
      subagentsEnabled: body.subagentsEnabled ?? true,
      labVerifyEnabled: body.labVerifyEnabled ?? true,
    };
    writePreferences(resolved.cwd, prefs);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
