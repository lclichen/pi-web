import { NextResponse } from "next/server";
import { resolveConfigCwdSync } from "@/lib/config-cwd";
import { deleteAgent, getAgentDetail, setAgentEnabled, updateAgent } from "@/lib/agents-service";
import type { AgentFields } from "@/lib/agents-service";
import type { ConfigScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null): ConfigScope {
  return v === "global" ? "global" : "project";
}

type AgentBody = AgentFields & { cwd?: string; projectId?: string; scope?: string; systemPrompt?: string };

// GET /api/agents/[name]?cwd=&scope=
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
  const cwd = dir.cwd;
  const { name } = await params;
  const scope = readScope(searchParams.get("scope"));
  try {
    const detail = getAgentDetail(cwd, scope, name);
    if (!detail) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// PUT /api/agents/[name]  body: { cwd, scope?, ...fields, systemPrompt }
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const body = (await req.json()) as AgentBody;
    const dir = resolveConfigCwdSync(req, { projectId: typeof (body as Record<string, unknown>).projectId === "string" ? (body as Record<string, unknown>).projectId as string : null, cwd: typeof body.cwd === "string" ? body.cwd : null });
    if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
    body.cwd = dir.cwd;
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const scope = readScope(body.scope ?? null);
    try {
      updateAgent(
        body.cwd,
        scope,
        name,
        {
          description: body.description,
          tools: body.tools,
          disallowedTools: body.disallowedTools,
          model: body.model,
          thinking: body.thinking,
          maxTurns: body.maxTurns,
        },
        body.systemPrompt ?? "",
      );
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

type PatchBody = { cwd?: string; scope?: string; enabled?: boolean };

// PATCH /api/agents/[name]  body: { cwd, scope?, enabled }
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
      setAgentEnabled(body.cwd, scope, name, body.enabled !== false);
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

// DELETE /api/agents/[name]?cwd=&scope=
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
    deleteAgent(cwd, scope, name);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
