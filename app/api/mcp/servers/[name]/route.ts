import { NextResponse } from "next/server";
import { removeMcpServer, setMcpServerDisabled, updateMcpServer } from "@/lib/mcp-config";
import type { ConfigScope, ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null): ConfigScope {
  return v === "global" ? "global" : "project";
}

type Body = { cwd?: string; scope?: string; entry?: ServerEntry };
type PatchBody = { cwd?: string; scope?: string; disabled?: boolean };

// PUT /api/mcp/servers/[name]  body: { cwd, scope?, entry }
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const body = (await req.json()) as Body;
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.entry || typeof body.entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }
    const scope = readScope(body.scope ?? null);
    try {
      updateMcpServer(body.cwd, scope, name, body.entry);
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

// PATCH /api/mcp/servers/[name]  body: { cwd, scope?, disabled }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const body = (await req.json()) as PatchBody;
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const scope = readScope(body.scope ?? null);
    try {
      setMcpServerDisabled(body.cwd, scope, name, Boolean(body.disabled));
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

// DELETE /api/mcp/servers/[name]?cwd=&scope=
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const scope = readScope(searchParams.get("scope"));
  try {
    removeMcpServer(cwd, scope, name);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
}
