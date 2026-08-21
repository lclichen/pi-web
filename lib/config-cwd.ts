import { ensureProjectHome, getOwnedProject, isCallerOwnedProjectHome } from "./projects";
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
 */

export function resolveConfigCwdSync(
  req: Request,
  params: { projectId?: string | null; cwd?: string | null },
): { ok: true; cwd: string; userId: number; isAdmin: boolean } | { ok: false; status: number; error: string } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: identity.status, error: "登录已失效" };
  const { user } = identity.session;

  if (params.projectId) {
    const project = getOwnedProject(params.projectId, user.id, user.role === "admin");
    if (!project) return { ok: false, status: 404, error: "项目不存在" };
    const home = ensureProjectHome(project);
    return { ok: true, cwd: home, userId: user.id, isAdmin: user.role === "admin" || user.id === 0 };
  }

  const cwd = params.cwd;
  if (!cwd || typeof cwd !== "string" || (!cwd.startsWith("/") && !cwd.startsWith("\\\\") && !isWindowsAbsolutePath(cwd))) {
    return { ok: false, status: 400, error: "cwd must be an absolute path" };
  }
  // Raw cwd path: host semantics — implicit host (auth off) or admin, plus
  // the caller's own project homes (config UIs pass the session cwd).
  const isAdmin = user.id === 0 || user.role === "admin";
  if (!isAdmin && !isCallerOwnedProjectHome(resolve(cwd), user.id, false)) {
    return { ok: false, status: 403, error: "服务器目录仅管理员可用" };
  }
  return { ok: true, cwd, userId: user.id, isAdmin };
}
