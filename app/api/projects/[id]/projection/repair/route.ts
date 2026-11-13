import { NextResponse } from "next/server";
import { getOwnedProject, projectHome } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { createProjectWorkspaceOperations } from "@/lib/project-workspace";
import { workspaceDescriptor } from "@/lib/workspace-key";
import { projectionWorkspaceFromDescriptor, reconcileProjection } from "@/lib/projection/reconcile";
import { readProjectionStatus } from "@/lib/projection/status";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/projects/:id/projection/repair — discard workspace edits and
// re-push Host versions. `paths` forces specific rels; `all` forces every
// currently dirty/conflicting path (plus a full attachment verification).
export async function POST(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;
  const project = getOwnedProject(id, user.id, user.role === "admin");
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  let body: { paths?: unknown; all?: unknown };
  try {
    body = (await req.json()) as { paths?: unknown; all?: unknown };
  } catch {
    body = {};
  }
  const all = body.all === true;
  const requestedPaths = Array.isArray(body.paths)
    ? body.paths.filter((path): path is string => typeof path === "string")
    : [];

  const descriptor = workspaceDescriptor(project);
  const previous = readProjectionStatus(project.id, descriptor.key);
  const forcePaths =
    requestedPaths.length > 0
      ? requestedPaths
      : all
        ? [...(previous?.dirty ?? []), ...(previous?.conflicts ?? [])]
        : [];

  const workspace = await createProjectWorkspaceOperations(project, user, identity.session.apiKey ?? "");
  if (!workspace.ok) {
    return NextResponse.json({ error: workspace.error }, { status: workspace.status });
  }

  try {
    const result = await reconcileProjection({
      projectId: project.id,
      hostHome: projectHome(project),
      workspace: workspace.workspace,
      workspaceMeta: projectionWorkspaceFromDescriptor(descriptor),
      budgetMs: 15_000,
      ...(forcePaths.length > 0 ? { forcePaths } : {}),
      forceFullVerify: all || requestedPaths.length === 0,
    });
    return NextResponse.json({
      ok: true,
      workspaceKey: descriptor.key,
      pushed: result.status.pushed,
      deleted: result.status.deleted,
      dirty: result.dirty,
      conflicts: result.conflicts,
      errors: result.errors,
      status: result.status,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
