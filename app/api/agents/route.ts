import { NextResponse } from "next/server";
import { resolveConfigCwdSync } from "@/lib/config-cwd";
import {
  createAgent,
  listAgents,
  listAllAgents,
  validateAgentName,
} from "@/lib/agents-service";
import { BUILTIN_PROFILES } from "@/lib/subagents";
import type { ConfigScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null): ConfigScope | undefined {
  return v === "project" || v === "global" ? v : undefined;
}

// GET /api/agents?cwd=&scope=  (scope omitted => project+global merged)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
  const cwd = dir.cwd;
  const scope = readScope(searchParams.get("scope"));
  try {
    const agents = scope ? listAgents(cwd, scope) : listAllAgents(cwd);
    // Append the built-in subagents (read-only) unless a same-named file-based
    // agent already overrides one — the spawn path gives files precedence, so
    // the listing must not show a shadowed builtin twice.
    if (!scope) {
      const overridden = new Set(agents.map((a) => a.name.toLowerCase()));
      for (const profile of BUILTIN_PROFILES) {
        if (overridden.has(profile.name.toLowerCase())) continue;
        agents.push({
          name: profile.name,
          scope: "builtin",
          filePath: "(builtin)",
          description: profile.description,
          tools: profile.tools,
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.thinking ? { thinking: profile.thinking } : {}),
          ...(profile.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
          enabled: profile.enabled,
          isDefault: true,
        });
      }
    }
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
      projectId?: string;
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
    const dir = resolveConfigCwdSync(req, { projectId: typeof body.projectId === "string" ? body.projectId : null, cwd: typeof body.cwd === "string" ? body.cwd : null });
    if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
    body.cwd = dir.cwd;
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
