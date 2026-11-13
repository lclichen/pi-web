import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { createProjectWorkspaceOperations } from "@/lib/project-workspace";
import {
  applyWorkspaceConfigSync,
  collectWorkspaceConfig,
  planWorkspaceConfigSync,
  verifyWorkspaceConfigBaseline,
} from "@/lib/workspace-config-sync";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { WorkspaceOperationError } from "@/lib/workspace-operations";
import { withProjectConfigReadLock, withProjectConfigWriteLock, ProjectConfigLockBusyError } from "@/lib/project-config-lock";
import { consumeSyncPlan, loadSyncPlan, saveSyncPlan } from "@/lib/sync-plan-store";
import { SyncBaselineConflictError } from "@/lib/sync-backups";
import { workspaceKeyFor } from "@/lib/workspace-key";
import { getProjectRuntimeBusy, reloadProjectSessions } from "@/lib/rpc-manager";
import { markProjectionDirty } from "@/lib/projection/reconcile";

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

class ProjectBusyError extends Error {
  constructor(public readonly sessions: string[], public readonly batchTasks: string[]) {
    super("项目有运行中的会话或批量任务，请等待它们结束或停止后再应用配置");
    this.name = "ProjectBusyError";
  }
}

// POST /api/projects/:id/workspace-config-sync
// body: { dryRun: true } | { token: "..." }
//
// dryRun collects the remote workspace's .pi/ through the project's mode
// provider, validates it exactly like a config bundle import, and caches the
// preview bytes behind a one-shot token. Apply consumes those bytes (no
// re-collect), re-checks that every collected home file is unchanged, and
// writes atomically with a backup.
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

  let body: { dryRun?: unknown; token?: unknown };
  try {
    body = (await req.json()) as { dryRun?: unknown; token?: unknown };
  } catch {
    body = {};
  }
  const token = typeof body.token === "string" ? body.token : "";
  const dryRun = body.dryRun === true;
  if (!dryRun && !token) {
    return NextResponse.json({ error: "缺少预览 token；请先 dry-run 预览" }, { status: 400 });
  }

  const workspaceKey = workspaceKeyFor(project);
  const home = ensureProjectHome(project);

  if (token) {
    return applyPlan(req, project, user, home, workspaceKey, token);
  }

  // Preview: read lock keeps the home snapshot consistent while an apply
  // waits; session starts are readers too and proceed in parallel.
  let planned;
  try {
    planned = await withProjectConfigReadLock(project.id, async () => {
      const workspace = await createProjectWorkspaceOperations(project, user, identity.session.apiKey ?? "");
      if (!workspace.ok) throw Object.assign(new Error(workspace.error), { httpStatus: workspace.status });
      const collected = await collectWorkspaceConfig(workspace.workspace);
      const plan = await planWorkspaceConfigSync(home, collected, {
        mode: project.mode,
        allowStdioMcp: user.role === "admin",
      });
      return plan;
    });
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus;
    if (status) return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: failureStatus(e) });
  }

  let saved;
  try {
    saved = await saveSyncPlan({
      userId: user.id,
      projectId: project.id,
      workspaceKey,
      stats: planned.stats,
      baseline: planned.baseline,
      preview: planned.files,
      writes: planned.writes,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 413 });
  }

  return NextResponse.json({
    ok: true,
    dryRun: true,
    token: saved.token,
    expiresAt: saved.expiresAt,
    workspaceKey,
    stats: planned.stats,
    files: planned.files,
    trust: getProjectTrustStatus(home, getAgentDir()),
  });
}

async function applyPlan(
  _req: Request,
  project: NonNullable<ReturnType<typeof getOwnedProject>>,
  user: { id: number; role: string },
  home: string,
  workspaceKey: string,
  token: string,
) {
  const loaded = await loadSyncPlan(token);
  if (!loaded.ok) {
    return NextResponse.json(
      {
        error:
          loaded.reason === "expired"
            ? "预览已过期，请重新预览"
            : loaded.reason === "used"
              ? "该预览已被使用，请重新预览"
              : "预览不存在，请重新预览",
        reason: loaded.reason,
      },
      { status: 410 },
    );
  }
  const plan = loaded.plan;
  if (plan.userId !== user.id || plan.projectId !== project.id || plan.workspaceKey !== workspaceKey) {
    return NextResponse.json({ error: "预览与当前项目/工作区不匹配，请重新预览" }, { status: 409 });
  }

  let applyId = "";
  try {
    applyId = await withProjectConfigWriteLock(project.id, async () => {
      const busy = await getProjectRuntimeBusy(project.id);
      if (busy.busy) throw new ProjectBusyError(busy.sessions, busy.batchTasks);
      const baseline = await verifyWorkspaceConfigBaseline(home, plan.baseline);
      if (!baseline.ok) throw new SyncBaselineConflictError(baseline.changed);
      const applied = await applyWorkspaceConfigSync(
        home,
        {
          writes: plan.writes,
          stats: plan.stats,
          baseline: plan.baseline,
          files: plan.preview,
        },
        { projectId: project.id, workspaceKey },
      );
      await consumeSyncPlan(token).catch(() => {
        // The apply succeeded; a leftover token is blocked by the baseline check.
      });
      return applied.applyId;
    });
  } catch (e) {
    if (e instanceof ProjectBusyError) {
      return NextResponse.json(
        { error: e.message, code: "PROJECT_BUSY", sessions: e.sessions, batchTasks: e.batchTasks },
        { status: 409 },
      );
    }
    if (e instanceof SyncBaselineConflictError) {
      return NextResponse.json({ error: e.message, code: "BASELINE_CONFLICT", changed: e.changed }, { status: 409 });
    }
    if (e instanceof ProjectConfigLockBusyError) {
      return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  let reload: Awaited<ReturnType<typeof reloadProjectSessions>> | null = null;
  // Host skills/agents changed: the next prompt should project them down.
  markProjectionDirty(project.id);
  try {
    // Per-session reload; do not hold the project read lock here — a reload can
    // start extension work that itself starts sessions, and the project lock is
    // not re-entrant.
    reload = await reloadProjectSessions(project.id);
  } catch {
    // Apply succeeded; reload is best-effort and reported as pending.
    reload = { reloaded: [], pending: [], failed: [] };
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    applyId,
    workspaceKey,
    stats: plan.stats,
    trust: getProjectTrustStatus(home, getAgentDir()),
    reload,
  });
}
