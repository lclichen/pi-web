import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { requireUserIdentity } from "@/lib/web-session";
import { isCallerOwnedProjectHome } from "@/lib/projects";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { isUserScopedConfig, userConfigDir, userSkillsDir } from "@/lib/user-config";

export const dynamic = "force-dynamic";

/** Gate a server path for the calling user: file-access roots plus their own
 *  project homes (sandbox/local projects manage skills through .pi/) and the
 *  caller's own user-scope skill store (user-config/u<id>/skills). */
async function pathAllowedForCaller(req: Request, target: string, extraRoots: string[] = []): Promise<boolean> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return false;
  const allowedRoots = new Set(await getAllowedFileRootsForRequest(req));
  const { user } = identity.session;
  if (isUserScopedConfig(user.id)) {
    allowedRoots.add(userSkillsDir(user.id));
    allowedRoots.add(path.join(userConfigDir(user.id), ".agents", "skills"));
  }
  for (const root of extraRoots) allowedRoots.add(root);
  if (isExistingFilePathAllowed(target, allowedRoots)) return true;
  return isCallerOwnedProjectHome(target, user.id, user.role === "admin");
}

/** Real-path containment (resolves symlinks); false when either side is absent
 *  or when the child IS the root. */
function realWithin(child: string, root: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realChild = realpathSync(child);
    if (realRoot === realChild) return false;
    const rel = path.relative(realRoot, realChild);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    if (!(await pathAllowedForCaller(req, cwd))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const identity = requireUserIdentity(req);
    if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd, identity.session.user.id));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json()) as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });
    // Globally installed skills live in ~/.agents/skills and are symlinked into
    // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
    // the real target sits outside getAgentDir(). Allow the global skills root
    // too (the SDK always treats ~/.agents/skills as trusted).
    const globalSkillsDir = path.join(homedir(), ".agents", "skills");
    const extraRoots = [getAgentDir(), ...(existsSync(globalSkillsDir) ? [globalSkillsDir] : [])];
    if (!(await pathAllowedForCaller(req, filePath, extraRoots))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(filePath, "utf8");
    const updated = setDisableModelInvocation(content, disableModelInvocation);
    writeFileSync(filePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE /api/skills?filePath=<.../SKILL.md|.../name.md>&cwd=<project>
// Removes an installed skill from disk. Allowed scopes: the caller's own
// user-scope skill store, the current project's skill dirs (cwd ownership
// checked), and — admins only — the global skill stores. Skill dirs are
// removed recursively (never the skill root itself); flat .md skills unlink
// just the file. Real paths are compared so a symlink cannot escape.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("filePath");
  const cwd = searchParams.get("cwd");
  if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
  if (!existsSync(filePath)) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const { user } = identity.session;
  const isAdmin = user.id === 0 || user.role === "admin";
  const roots: string[] = [];
  if (isUserScopedConfig(user.id)) {
    roots.push(userSkillsDir(user.id), path.join(userConfigDir(user.id), ".agents", "skills"));
  }
  if (isAdmin) {
    roots.push(path.join(getAgentDir(), "skills"), path.join(homedir(), ".agents", "skills"));
  }
  if (cwd) {
    if (!(await pathAllowedForCaller(req, cwd))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    roots.push(path.join(cwd, ".pi", "skills"), path.join(cwd, ".agents", "skills"));
  }

  const base = path.basename(filePath);
  const isSkillFile = base.toLowerCase() === "skill.md";
  const isFlatMarkdown = !isSkillFile && path.extname(filePath).toLowerCase() === ".md";
  if (!isSkillFile && !isFlatMarkdown) {
    return NextResponse.json({ error: "只能删除技能文件（SKILL.md 或 .md）" }, { status: 400 });
  }
  // Directory-based skills: the SKILL.md's parent is the skill directory. A
  // SKILL.md that sits directly in the skills root is a flat skill — delete
  // just that file, never the whole skills root.
  const realFile = (() => {
    try {
      return realpathSync(filePath);
    } catch {
      return null;
    }
  })();
  if (!realFile) return NextResponse.json({ error: "file not found" }, { status: 404 });
  const parent = realpathSync(path.dirname(realFile));
  const parentIsRoot = roots.some((root) => {
    try {
      return existsSync(root) && realpathSync(root) === parent;
    } catch {
      return false;
    }
  });
  const deleteDirectory = isSkillFile && !parentIsRoot;
  const target = deleteDirectory ? parent : realFile;
  if (!roots.some((root) => existsSync(root) && realWithin(target, root))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    rmSync(target, { recursive: deleteDirectory, force: false });
    return NextResponse.json({ success: true, removed: target });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
