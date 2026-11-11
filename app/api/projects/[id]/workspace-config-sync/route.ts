import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { createProjectWorkspaceOperations } from "@/lib/project-workspace";
import { applyWorkspaceConfigSync, collectWorkspaceConfig, planWorkspaceConfigSync } from "@/lib/workspace-config-sync";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { WorkspaceOperationError } from "@/lib/workspace-operations";

export const dynamic = "force-dynamic";

function failureStatus(error: unknown): number {
  if (error instanceof WorkspaceOperationError) {
    if (error.code === "UNSUPPORTED") return 409;
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "OUT_OF_SCOPE" || error.code === "READ_ONLY") return 400;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/没有 \.pi 目录|不是目录|没有可同步/.test(message)) return 404;
  if (/过大|过多/.test(message)) return 413;
  return 502;
}

// POST /api/projects/:id/workspace-config-sync
// body: { dryRun?: boolean }
//
// Reads the remote project workspace's .pi/ through the project's own mode
// provider (sandbox / local-machine / SSH), validates it exactly like a config
// bundle import, and applies it to the server-side project home. dryRun
// returns the same validation + diff summary without writing.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;
  const project = getOwnedProject(id, user.id);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  let dryRun = false;
  try {
    const body = (await req.json()) as { dryRun?: unknown };
    dryRun = body?.dryRun === true;
  } catch {
    // empty body = apply
  }

  const workspace = await createProjectWorkspaceOperations(project, user, identity.session.apiKey ?? "");
  if (!workspace.ok) {
    return NextResponse.json({ error: workspace.error }, { status: workspace.status });
  }

  let collected;
  try {
    collected = await collectWorkspaceConfig(workspace.workspace);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: failureStatus(e) });
  }

  const home = ensureProjectHome(project);
  let plan;
  try {
    plan = await planWorkspaceConfigSync(home, collected, {
      mode: project.mode,
      allowStdioMcp: user.role === "admin",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  if (!dryRun) {
    try {
      await applyWorkspaceConfigSync(home, plan);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    stats: plan.stats,
    trust: getProjectTrustStatus(home, getAgentDir()),
  });
}
