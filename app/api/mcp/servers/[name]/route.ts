import { NextResponse } from "next/server";
import { removeMcpServer, setMcpServerDisabled, updateMcpServer } from "@/lib/mcp-config";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import type { ConfigScope, ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null | undefined): ConfigScope {
  return v === "global" ? "global" : "project";
}

type Body = { cwd?: string; projectId?: string; scope?: string; entry?: ServerEntry };
type PatchBody = { cwd?: string; projectId?: string; scope?: string; disabled?: boolean };

// PUT /api/mcp/servers/[name]  body: { cwd|projectId, scope?, entry }
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const body = (await req.json()) as Body;
    if (!body.entry || typeof body.entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }
    const guard = guardMcpRequest(req, body, { mutating: true });
    if (!guard.ok) return guard.response;
    const scope = readScope(body.scope);
    try {
      updateMcpServer(guard.cwd, scope, name, body.entry);
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 404 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// PATCH /api/mcp/servers/[name]  body: { cwd|projectId, scope?, disabled }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const body = (await req.json()) as PatchBody;
    const guard = guardMcpRequest(req, body, { mutating: true });
    if (!guard.ok) return guard.response;
    const scope = readScope(body.scope);
    try {
      setMcpServerDisabled(guard.cwd, scope, name, Boolean(body.disabled));
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 404 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// DELETE /api/mcp/servers/[name]?cwd=|projectId=&scope=
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const { searchParams } = new URL(req.url);
  const guard = guardMcpRequest(
    req,
    { cwd: searchParams.get("cwd"), projectId: searchParams.get("projectId"), scope: searchParams.get("scope") },
    { mutating: true },
  );
  if (!guard.ok) return guard.response;
  const scope = readScope(searchParams.get("scope"));
  try {
    removeMcpServer(guard.cwd, scope, name);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
}
