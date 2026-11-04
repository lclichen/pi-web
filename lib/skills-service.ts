import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { SkillInfo, SkillsResponse } from "./api-types";
import { annotateSkillsWithInstallInfo } from "./skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { isUserScopedConfig, userConfigDir, userSkillsDir } from "./user-config";

export async function loadSkillsWithInstallInfo(cwd: string, userId = 0): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const extraSkillPaths: string[] = [];
  if (isUserScopedConfig(userId)) {
    extraSkillPaths.push(userSkillsDir(userId), join(userConfigDir(userId), ".agents", "skills"));
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...(extraSkillPaths.length > 0 ? { additionalSkillPaths: extraSkillPaths } : {}),
  });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
