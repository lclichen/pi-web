import { createProjectWorkspaceOperations } from "../project-workspace";
import { projectHome, type ProjectRecord } from "../projects";
import { workspaceDescriptor } from "../workspace-key";
import { projectionWorkspaceFromDescriptor } from "./reconcile";
import type { ProjectionSessionConfig } from "./types";

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
  const descriptor = workspaceDescriptor(project);
  return {
    projectId: project.id,
    hostHome: projectHome(project),
    workspaceMeta: projectionWorkspaceFromDescriptor(descriptor),
    workspace: async () => {
      const result = await createProjectWorkspaceOperations(project, user, apiKey);
      if (!result.ok) throw new Error(result.error);
      return result.workspace;
    },
  };
}
