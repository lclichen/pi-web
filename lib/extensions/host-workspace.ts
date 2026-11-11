import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { registerWorkspaceService } from "./workspace-service";
import { createHostWorkspaceOperations } from "../workspace-providers/host";

/** Host-mode workspace provider service (local fs + local shell). */
export function makeHostWorkspaceServiceExtension(root: string): InlineExtension {
  const factory = (pi: ExtensionAPI): void => {
    registerWorkspaceService(pi, () => createHostWorkspaceOperations(root));
  };
  return { name: "pi-web-host-workspace", factory, hidden: true };
}
