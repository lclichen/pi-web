import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillToggleResult } from "@/lib/api-types";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import { getAllowedFileRoots, getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { requireUserIdentity } from "@/lib/web-session";
import { isCallerOwnedProjectHome } from "@/lib/projects";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** Gate a server path for the calling user: file-access roots plus their own
 *  project homes (sandbox/local projects manage skills through .pi/). */
async function pathAllowedForCaller(req: Request, target: string, extraRoots: string[] = []): Promise<boolean> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return false;
  const allowedRoots = new Set(await getAllowedFileRootsForRequest(req));
  for (const root of extraRoots) allowedRoots.add(root);
  if (isExistingFilePathAllowed(target, allowedRoots)) return true;
  return isCallerOwnedProjectHome(target, identity.session.user.id, identity.session.user.role === "admin");
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
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

async function getSkillEditRoots(): Promise<Set<string>> {
  const allowedRoots = new Set(await getAllowedFileRoots());
  allowedRoots.add(getAgentDir());
  // Globally installed skills live in ~/.agents/skills and are symlinked into
  // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
  // the real target sits outside getAgentDir(). Allow the global skills root
  // too (the SDK always treats ~/.agents/skills as trusted).
  const globalSkillsDir = path.join(homedir(), ".agents", "skills");
  if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
  return allowedRoots;
}

/**
 * The root set one skill edit may write, under dev's per-caller fence:
 * the caller's file-access roots plus the skill edit roots. A target only the
 * caller's own project home allows (sandbox/local project skills) passes the
 * fence on ownership, and the home itself joins the set for the write check.
 * Null when the caller may not touch the target at all.
 */
async function editRootsForCaller(req: Request, target: string): Promise<Set<string> | null> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return null;
  const roots = new Set(await getSkillEditRoots());
  for (const root of await getAllowedFileRootsForRequest(req)) roots.add(root);
  if (!isExistingFilePathAllowed(target, roots)) {
    const owned = isCallerOwnedProjectHome(target, identity.session.user.id, identity.session.user.role === "admin");
    if (!owned) return null;
    roots.add(target);
  }
  return roots;
}

/** Edits one SKILL.md, or returns the status and message that refused it. */
function toggleSkillFile(
  filePath: string,
  disableModelInvocation: boolean,
  allowedRoots: Set<string>,
): { status: number; error: string } | null {
  // Skills are SKILL.md or *.md files. The allowed roots also hold settings,
  // auth.json and project files, whose top a frontmatter edit would break.
  if (path.extname(filePath).toLowerCase() !== ".md") return { status: 400, error: "Not a skill file" };
  if (!existsSync(filePath)) return { status: 404, error: "file not found" };
  if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
    return { status: 403, error: "Access denied" };
  }
  const content = readFileSync(filePath, "utf8");
  const updated = setDisableModelInvocation(content, disableModelInvocation);
  // A skill already in the requested state keeps its file and mtime.
  if (updated !== content) writeFileSync(filePath, updated, "utf8");
  return null;
}

// PATCH /api/skills — toggle disable-model-invocation on SKILL.md files.
// Body: { filePath, disableModelInvocation } for one skill, or
// { filePaths, disableModelInvocation } for the panel's "Enable all" /
// "Disable all". A batch edits each file on its own and reports every one, so
// a skill the route refuses does not stop the rest.
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    // MERGE-NOTE(upgrade/1.0): upstream adds a batch form (`filePaths`) for the
    // panel's Enable/Disable all; dev keeps its per-caller fence for both the
    // single and the batch path instead of upstream's global root check.
    const body = await req.json() as {
      filePath?: string;
      filePaths?: unknown;
      disableModelInvocation: boolean;
    };
    const { filePath, filePaths, disableModelInvocation } = body;

    if (filePaths !== undefined) {
      if (!Array.isArray(filePaths) || !filePaths.every((item) => typeof item === "string" && item)) {
        return NextResponse.json({ error: "filePaths must be a list of paths" }, { status: 400 });
      }
      if (typeof disableModelInvocation !== "boolean") {
        return NextResponse.json({ error: "disableModelInvocation must be a boolean" }, { status: 400 });
      }
      const results: SkillToggleResult[] = [];
      for (const target of new Set(filePaths as string[])) {
        try {
          const allowedRoots = await editRootsForCaller(req, target);
          if (!allowedRoots) {
            results.push({ filePath: target, error: "Access denied" });
            continue;
          }
          const refused = toggleSkillFile(target, disableModelInvocation, allowedRoots);
          results.push(refused ? { filePath: target, error: refused.error } : { filePath: target });
        } catch (e) {
          results.push({ filePath: target, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return NextResponse.json({ results });
    }

    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });
    const allowedRoots = await editRootsForCaller(req, filePath);
    if (!allowedRoots) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const refused = toggleSkillFile(filePath, disableModelInvocation, allowedRoots);
    if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
