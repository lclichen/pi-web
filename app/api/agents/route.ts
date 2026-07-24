import { NextResponse } from "next/server";
import {
  createAgent,
  listAgents,
  listAllAgents,
  validateAgentName,
} from "@/lib/agents-service";
import type { ConfigScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null): ConfigScope | undefined {
  return v === "project" || v === "global" ? v : undefined;
}

// GET /api/agents?cwd=&scope=  (scope omitted => project+global merged)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const scope = readScope(searchParams.get("scope"));
  try {
    const agents = scope ? listAgents(cwd, scope) : listAllAgents(cwd);
    return NextResponse.json({ agents });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// POST /api/agents  body: { cwd, scope?, name, ...fields, systemPrompt? }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      cwd?: string;
      scope?: string;
      name?: string;
      description?: string;
      tools?: string[];
      disallowedTools?: string[];
      model?: string;
      thinking?: string;
      maxTurns?: number;
      systemPrompt?: string;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const nameErr = validateAgentName(body.name);
    if (nameErr) return NextResponse.json({ error: nameErr }, { status: 400 });

    const scope = readScope(body.scope ?? null) ?? "project";
    try {
      const filePath = createAgent(
        body.cwd,
        scope,
        body.name.trim(),
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
      return NextResponse.json({ success: true, filePath });
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
