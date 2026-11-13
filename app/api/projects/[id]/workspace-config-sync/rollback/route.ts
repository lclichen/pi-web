import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { withProjectConfigWriteLock, ProjectConfigLockBusyError } from "@/lib/project-config-lock";
import { rollbackWorkspaceConfig, SyncRollbackConflictError } from "@/lib/sync-backups";
import { workspaceKeyFor } from "@/lib/workspace-key";
import { getProjectRuntimeBusy, reloadProjectSessions } from "@/lib/rpc-manager";
import { markProjectionDirty } from "@/lib/projection/reconcile";
import { readProjectionStatus } from "@/lib/projection/status";
import { workspaceDescriptor } from "@/lib/workspace-key";

export const dynamic = "force-dynamic";

// POST /api/projects/:id/workspace-config-sync/rollback
// body: { applyId: string, force?: boolean }
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

  let body: { applyId?: unknown; force?: unknown };
  try {
    body = (await req.json()) as { applyId?: unknown; force?: unknown };
  } catch {
    body = {};
  }
  const applyId = typeof body.applyId === "string" ? body.applyId : "";
  if (!applyId) return NextResponse.json({ error: "缺少 applyId" }, { status: 400 });
  const force = body.force === true;
  const home = ensureProjectHome(project);
  const workspaceKey = workspaceKeyFor(project);

  let result;
  try {
    result = await withProjectConfigWriteLock(project.id, async () => {
      const busy = await getProjectRuntimeBusy(project.id);
      if (busy.busy) {
        throw Object.assign(new Error("项目有运行中的会话或批量任务，请等待它们结束或停止后再回滚"), {
          code: "PROJECT_BUSY",
          sessions: busy.sessions,
          batchTasks: busy.batchTasks,
        });
      }
      return rollbackWorkspaceConfig(home, applyId, { force, projectId: project.id, workspaceKey });
    });
  } catch (e) {
    if (e instanceof SyncRollbackConflictError) {
      return NextResponse.json({ error: e.message, code: "ROLLBACK_CONFLICT", changed: e.changed }, { status: 409 });
    }
    if (e instanceof ProjectConfigLockBusyError) {
      return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
    }
    const code = (e as { code?: unknown }).code;
    if (code === "PROJECT_BUSY") {
      return NextResponse.json(
        {
          error: e instanceof Error ? e.message : String(e),
          code: "PROJECT_BUSY",
          sessions: (e as { sessions?: string[] }).sessions ?? [],
          batchTasks: (e as { batchTasks?: string[] }).batchTasks ?? [],
        },
        { status: 409 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: /找不到该同步备份/.test(message) ? 404 : 500 });
  }

  let reload: Awaited<ReturnType<typeof reloadProjectSessions>> | null = null;
  markProjectionDirty(project.id);
  try {
    reload = await reloadProjectSessions(project.id);
  } catch {
    reload = { reloaded: [], pending: [], failed: [] };
  }

  const descriptor = workspaceDescriptor(project);
  const projection = readProjectionStatus(project.id, descriptor.key);
  const dirty = projection?.dirty ?? [];
  const conflicts = projection?.conflicts ?? [];
  return NextResponse.json({
    ok: true,
    applyId: result.applyId,
    restored: result.restored,
    deleted: result.deleted,
    paths: result.paths,
    workspaceKey,
    trust: getProjectTrustStatus(home, getAgentDir()),
    reload,
    // The workspace may still hold the Agent's edited version; the UI offers
    // "discard workspace changes" (POST /projection/repair).
    projection: {
      needsDiscard: dirty.length > 0 || conflicts.length > 0,
      dirty,
      conflicts,
    },
  });
}
