import { NextResponse } from "next/server";
import {
  readMcpConfig,
  removeMcpServer,
  setMcpServerDisabled,
  setMcpServerDisabledViaProject,
  updateMcpServer,
} from "@/lib/mcp-config";
import { getOwnedProject } from "@/lib/projects";
import { relayWorkspaceEntryProblem } from "@/lib/relay-mcp-policy";
import { guardMcpRequest } from "@/lib/mcp-route-guard";
import { withProjectConfigWriteLockFor, ProjectConfigLockBusyError } from "@/lib/project-config-lock";
import type { ConfigScope, ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function readScope(v: string | null | undefined): ConfigScope {
  return v === "global" ? "global" : v === "quick" ? "quick" : v === "user" ? "user" : "project";
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
    const project =
      scope === "project" && guard.projectId
        ? getOwnedProject(guard.projectId, guard.userId)
        : undefined;
    const relayWorkspaceStdio =
      scope === "project" &&
      project?.mode === "local-machine" &&
      body.entry.piWeb?.plane === "workspace";
    if ((scope === "project" || scope === "user") && !guard.isAdmin && body.entry.command && !relayWorkspaceStdio) {
      return NextResponse.json(
        {
          error:
            "项目级 stdio MCP 默认会在 pi-web 服务器进程内启动，普通用户不可用。本机模式项目可改用 http MCP，或在条目的 piWeb.plane 声明 \"workspace\" 让它在你的配对机器上运行。",
        },
        { status: 403 },
      );
    }
    if (relayWorkspaceStdio) {
      const problem = relayWorkspaceEntryProblem(body.entry);
      if (problem) return NextResponse.json({ error: `workspace MCP 配置不安全：${problem}` }, { status: 400 });
    }
    try {
      // 项目 scope 写 <project home>/.pi/mcp.json → 共享项目写锁（ADR-0004
      // §4.2）；全局/用户/quick scope 写数据目录，不加锁。
      const entry = body.entry;
      await withProjectConfigWriteLockFor(scope === "project" ? guard.projectId : undefined, async () => {
        updateMcpServer(guard.cwd, scope, name, entry, guard.userId);
      });
      return NextResponse.json({ success: true });
    } catch (e) {
      if (e instanceof ProjectConfigLockBusyError) {
        return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
      }
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
        // 直接改 scope 自身的配置：只有 project scope 落在项目 home，加锁。
        await withProjectConfigWriteLockFor(scope === "project" ? guard.projectId : undefined, async () => {
          setMcpServerDisabled(guard.cwd, scope, name, disabled, guard.userId);
        });
        return NextResponse.json({ success: true, disabled, target });
      }
      // 工作区覆盖写 <project home>/.pi/mcp.json → 项目写锁。
      await withProjectConfigWriteLockFor(guard.projectId, async () => {
        setMcpServerDisabledViaProject(guard.cwd, name, disabled);
      });
      if (!disabled) {
        // Removing the override can expose a server that is disabled in its
        // own config (global/quick). Say so instead of silently no-oping.
        const effective = readMcpConfig(guard.cwd, { userId: guard.userId }).servers.find((s) => s.name === name);
        if (effective?.disabled) {
          return NextResponse.json(
            { error: "项目覆盖已移除，但该服务器在全局/快速配置中仍为禁用；需管理员在对应配置中启用" },
            { status: 409 },
          );
        }
      }
      return NextResponse.json({ success: true, disabled, target });
    } catch (e) {
      if (e instanceof ProjectConfigLockBusyError) {
        return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
      }
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
    // 项目 scope 写 <project home>/.pi/mcp.json → 共享项目写锁；其余 scope
    // 写数据目录/用户目录，不加锁。
    await withProjectConfigWriteLockFor(scope === "project" ? guard.projectId : undefined, async () => {
      removeMcpServer(guard.cwd, scope, name, guard.userId);
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    if (e instanceof ProjectConfigLockBusyError) {
      return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
