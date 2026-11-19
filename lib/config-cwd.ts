import { ensureProjectHome, getOwnedProject, isCallerOwnedProjectHome, projectIdForHome } from "./projects";
import { isCallerQuickWorkspace } from "./mode-homes";
import { requireUserIdentity } from "./web-session";
import { isWindowsAbsolutePath } from "./file-access";
import { resolve } from "path";

/**
 * Config-API cwd resolution (design doc §"配置管理 API 修复"): config routes
 * (plugins / agents / mcp) receive either a projectId (project-scoped session —
 * the cwd is derived server-side and ownership-checked) or a raw cwd (host
 * mode, admin/root only, plus the caller's OWN project homes). This closes
 * both the "remote sessions passed cwd=/" gap and the missing identity checks
 * on the agents/mcp routes.
 *
 * The ok result carries `projectId` when the resolved cwd is a project home
 * (explicit projectId param, or reverse-mapped from a raw cwd that points at
 * one) so project-scope config writes can take the shared project write lock
 * (ADR-0004 §4.2).
 */

export function resolveConfigCwdSync(
  req: Request,
  params: { projectId?: string | null; cwd?: string | null },
):
  | { ok: true; cwd: string; projectId?: string; userId: number; isAdmin: boolean }
  | { ok: false; status: number; error: string } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: identity.status, error: "登录已失效" };
  const { user } = identity.session;

  if (params.projectId) {
    const project = getOwnedProject(params.projectId, user.id, user.role === "admin");
    if (!project) return { ok: false, status: 404, error: "项目不存在" };
    const home = ensureProjectHome(project);
    return {
      ok: true,
      cwd: home,
      projectId: project.id,
      userId: user.id,
      isAdmin: user.role === "admin" || user.id === 0,
    };
  }

  const cwd = params.cwd;
  if (
    !cwd ||
    typeof cwd !== "string" ||
    (!cwd.startsWith("/") && !cwd.startsWith("\\\\") && !isWindowsAbsolutePath(cwd))
  ) {
    return { ok: false, status: 400, error: "cwd must be an absolute path" };
  }
  // Raw cwd path: host semantics — implicit host (auth off) or admin, plus
  // the caller's own project homes (config UIs pass the session cwd) and the
  // caller's own quick workspaces (quick-homes/u<id> — materialized by
  // /api/quick-workspace BEFORE the first message, so no session cwd exists
  // to authorize them yet; without this a non-admin quick session 403s every
  // config API: mcp / agents / plugins / preferences / skills).
  const isAdmin = user.id === 0 || user.role === "admin";
  if (!isAdmin && !isCallerOwnedProjectHome(resolve(cwd), user.id, false) && !isCallerQuickWorkspace(cwd, user.id)) {
    return { ok: false, status: 403, error: "服务器目录仅管理员可用" };
  }
  return { ok: true, cwd, projectId: projectIdForHome(cwd), userId: user.id, isAdmin };
}
