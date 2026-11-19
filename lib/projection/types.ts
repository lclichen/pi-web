import type { WorkspaceOperations } from "../workspace-operations";
import type { ProjectionWorkspace } from "./manifest";

/** Per-session projection context wired into startRpcSession by the routes. */
export interface ProjectionSessionConfig {
  projectId: string;
  /** Host project home containing `.pi/skills|agents|attachments`. */
  hostHome: string;
  workspaceMeta: ProjectionWorkspace;
  /** Lazy provider: sandbox containers/relay agents may be offline at startup. */
  workspace: () => Promise<WorkspaceOperations>;
  /** 首尾复校：reconcile 结束前重新解析当前工作区身份（见 projectionWorkspaceRecheck）。 */
  workspaceRecheck: () => ProjectionWorkspace | null;
}
