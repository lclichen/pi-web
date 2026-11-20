import { createProjectWorkspaceOperations } from "../project-workspace";
import { getProject, projectHome, type ProjectRecord } from "../projects";
import { workspaceDescriptor } from "../workspace-key";
import { projectionWorkspaceFromDescriptor } from "./reconcile";
import type { ProjectionSessionConfig } from "./types";
import type { ProjectionWorkspace } from "./manifest";

/**
 * Build the per-session projection context for a remote project. The workspace
 * provider is lazy: a sandbox container or relay agent may be offline at session
 * start, and projection must never block the session from starting.
 */
export function projectionSessionFor(
  project: ProjectRecord,
  user: { id: number; role: string },
  apiKey: string,
): ProjectionSessionConfig {
  if (project.mode === "host" || project.mode === "quick") {
    throw new Error("Host/Quick projects do not use workspace projection");
  }
  const descriptor = { ...workspaceDescriptor(project), mode: project.mode };
  return {
    projectId: project.id,
    hostHome: projectHome(project),
    workspaceMeta: projectionWorkspaceFromDescriptor(descriptor),
    workspace: async () => {
      const result = await createProjectWorkspaceOperations(project, user, apiKey);
      if (!result.ok) throw new Error(result.error);
      return result.workspace;
    },
    workspaceRecheck: () => projectionWorkspaceRecheck(project.id),
  };
}

/**
 * 首尾复校（ADR §3.1）：reconcile 结束保存前重新解析项目当前的 descriptor。
 * 调用时才经 getProject 读取，捕捉 reconcile 进行中的 workdir/machine/container
 * 修改；项目已不存在时返回 null（同样视为“已变化”）。
 */
export function projectionWorkspaceRecheck(projectId: string): ProjectionWorkspace | null {
  const project = getProject(projectId);
  if (!project || project.mode === "host" || project.mode === "quick") return null;
  return projectionWorkspaceFromDescriptor({ ...workspaceDescriptor(project), mode: project.mode });
}
