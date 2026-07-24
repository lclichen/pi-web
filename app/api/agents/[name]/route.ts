import { NextResponse } from "next/server";
import { deleteAgent, getAgentDetail, updateAgent } from "@/lib/agents-service";
import type { AgentFields } from "@/lib/agents-service";
import type { ConfigScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null): ConfigScope {
  return v === "global" ? "global" : "project";
}

type AgentBody = AgentFields & { cwd?: string; scope?: string; systemPrompt?: string };

// GET /api/agents/[name]?cwd=&scope=
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
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
