import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillInfo, SkillsResponse } from "./api-types";
import { annotateSkillsWithInstallInfo } from "./skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { isUserScopedConfig, userConfigDir, userSkillsDir } from "./user-config";

function isWithin(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Lexical containment plus a real-path check for symlinked skill dirs. */
function withinAny(child: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (isWithin(child, root)) return true;
    try {
      if (isWithin(realpathSync(child), realpathSync(root))) return true;
    } catch {
      // Root or child absent: the lexical answer stands.
    }
  }
  return false;
}

export async function loadSkillsWithInstallInfo(cwd: string, userId = 0): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const extraSkillPaths: string[] = [];
  const userSkillRoots: string[] = [];
  if (isUserScopedConfig(userId)) {
    extraSkillPaths.push(userSkillsDir(userId), join(userConfigDir(userId), ".agents", "skills"));
    userSkillRoots.push(userSkillsDir(userId), join(userConfigDir(userId), ".agents", "skills"));
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...(extraSkillPaths.length > 0 ? { additionalSkillPaths: extraSkillPaths } : {}),
  });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const annotated = annotateSkillsWithInstallInfo(skills as SkillInfo[], {
    cwd,
    agentDir,
    ...(userSkillRoots.length > 0
      ? {
          userSkillsRoot: userSkillsDir(userId),
          userLockPath: join(userConfigDir(userId), "skills-lock.json"),
        }
      : {}),
  });
  const globalSkillRoots = [join(agentDir, "skills"), join(homedir(), ".agents", "skills")];
  const projectSkillRoots = [join(cwd, ".pi", "skills"), join(cwd, ".agents", "skills")];

  // The SDK calls the global agent dir "user" (upstream has no per-user
  // layer); the web UI needs the real distinction: the caller's own store is
  // user scope, anything shared under the agent dir is global. Path-based
  // attribution also fixes global npm-package skills (agentDir/npm/...).
  const scoped = annotated.map((skill) => {
    const scope = withinAny(skill.filePath, userSkillRoots)
      ? "user"
      : withinAny(skill.filePath, projectSkillRoots)
        ? "project"
        : withinAny(skill.filePath, globalSkillRoots) || isWithin(skill.filePath, agentDir)
          ? "global"
          : skill.sourceInfo?.scope === "project"
            ? "project"
            : skill.sourceInfo?.scope === "user"
              ? "global"
              : skill.sourceInfo?.scope === "global"
                ? "global"
                : undefined;
    return scope ? { ...skill, sourceInfo: { ...(skill.sourceInfo ?? {}), scope } } : skill;
  });
  return {
    skills: scoped,
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
