import { NextResponse } from "next/server";
import {
  readMcpConfig,
  removeMcpServer,
  setMcpServerDisabled,
  setMcpServerDisabledViaProject,
  updateMcpServer,
} from "@/lib/mcp-config";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import type { ConfigScope, ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null | undefined): ConfigScope {
  return v === "global" ? "global" : v === "quick" ? "quick" : "project";
}

type Body = { cwd?: string; projectId?: string; scope?: string; entry?: ServerEntry };
type PatchBody = {
  cwd?: string;
  projectId?: string;
  scope?: string;
  disabled?: boolean;
  /** "project" (default) = workspace override; "scope" = edit the entry's own config. */
  target?: "project" | "scope";
};

// PUT /api/mcp/servers/[name]  body: { cwd|projectId, scope?, entry }
export async function PUT(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const body = (await req.json()) as Body;
    if (!body.entry || typeof body.entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }
    const guard = guardMcpRequest(req, body, { mutating: true });
    if (!guard.ok) return guard.response;
    const scope = readScope(body.scope);
    if (scope === "project" && !guard.isAdmin && body.entry.command) {
      return NextResponse.json(
        {
          error:
            "项目级 stdio MCP 会在 pi-web 服务器进程内启动，普通用户不可用。请改用 http MCP，或联系管理员在全局配置中添加。",
        },
        { status: 403 },
      );
    }
    try {
      updateMcpServer(guard.cwd, scope, name, body.entry);
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// PATCH /api/mcp/servers/[name]  body: { cwd|projectId, scope?, disabled, target? }
export async function PATCH(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const body = (await req.json()) as PatchBody;
    const scope = readScope(body.scope);
    // Default = workspace override: a project-level {disabled:true} tombstone
    // hides a global/quick server for THIS project without touching the
    // original config. The adapter treats it as absent; enabling removes it.
    // target:"scope" keeps the old direct edit (admin-only for global), used
    // by the settings form when an admin edits the entry's own config.
    const target = body.target === "scope" ? "scope" : "project";
    const guard = guardMcpRequest(req, { ...body, scope: target === "scope" ? scope : "project" }, { mutating: true });
    if (!guard.ok) return guard.response;
    const disabled = body.disabled === true;
    try {
      if (target === "scope") {
        setMcpServerDisabled(guard.cwd, scope, name, disabled);
        return NextResponse.json({ success: true, disabled, target });
      }
      setMcpServerDisabledViaProject(guard.cwd, name, disabled);
      if (!disabled) {
        // Removing the override can expose a server that is disabled in its
        // own config (global/quick). Say so instead of silently no-oping.
        const effective = readMcpConfig(guard.cwd).servers.find((s) => s.name === name);
        if (effective?.disabled) {
          return NextResponse.json(
            { error: "项目覆盖已移除，但该服务器在全局/快速配置中仍为禁用；需管理员在对应配置中启用" },
            { status: 409 },
          );
        }
      }
      return NextResponse.json({ success: true, disabled, target });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// DELETE /api/mcp/servers/[name]?cwd=|projectId=&scope=
export async function DELETE(req: Request, { params }: { params: Promise<{ name: string }> }) {
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
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
