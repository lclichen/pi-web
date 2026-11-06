import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillInfo, SkillsResponse } from "./api-types";
import { annotateSkillsWithInstallInfo } from "./skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { isUserScopedConfig, userConfigDir, userSkillsDir } from "./user-config";

function isWithin(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
  const annotated = annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir });
  // Additional skill paths are reported as generic "path" sources; label the
  // caller's own user store as "user" so the UI can group and manage it.
  const scoped =
    userSkillRoots.length === 0
      ? annotated
      : annotated.map((skill) =>
          userSkillRoots.some((root) => isWithin(skill.filePath, root))
            ? { ...skill, sourceInfo: { ...(skill.sourceInfo ?? {}), scope: "user" } }
            : skill,
        );
  return {
    skills: scoped,
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
