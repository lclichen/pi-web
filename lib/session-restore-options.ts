import { existsSync } from "fs";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { RpcSessionStartOptions } from "./rpc-manager";
import { getSessionMeta } from "./session-metas";
import { ensureProjectHome, getOwnedProject, projectHome, writeSandboxConfig } from "./projects";
import { ensureLocalHome, ensureSandboxHome } from "./mode-homes";
import { spaceDir } from "./session-spaces";
import { makeRelayToolsExtension } from "./extensions/relay-tools";
import { makeRemoteVerifyExtension } from "./extensions/remote-verify";
import { makeEnvironmentInfoExtension } from "./extensions/environment-info";
import { requireUserIdentity } from "./web-session";
import { getAgentForUser } from "./relay/registry";

/**
 * Rebuild the session-start options for a RESTORED session.
 *
 * /api/agent/new injects the mode extensions (sandbox bridge / relay tools /
 * remote-verify / environment info) when a session is CREATED. The restore
 * paths (POST /api/agent/[id], events, auto-name) used to call
 * startRpcSession with NO options — a restored sandbox session then ran as a
 * bare local pi session: every tool executed in the server-side project home
 * instead of the container, and the session lost its owner/mode registration.
 * This helper derives the same injections from the session's recorded meta.
 */
export async function restoreSessionOptions(req: Request, sessionId: string): Promise<RpcSessionStartOptions> {
  const identity = requireUserIdentity(req);
  // Identity failing here is handled by the caller's access check; fall back
  // to bare options rather than throwing.
  if (!identity.ok) return {};
  const { user } = identity.session;

  const meta = getSessionMeta(sessionId);
  const mode = meta?.mode ?? "host";
  const project = meta?.projectId ? getOwnedProject(meta.projectId, meta.ownerId ?? user.id, user.role === "admin") : undefined;

  let additionalExtensionPaths: string[] | undefined;
  let extensionFactories: InlineExtension[] | undefined;
  let effectiveCwd: string | undefined;

  if (mode === "sandbox") {
    const extPath = process.env.PI_WEB_SANDBOX_EXTENSION_PATH;
    const apiKey = identity.session.apiKey;
    if (process.env.PI_WEB_PLATFORM_URL && extPath && existsSync(extPath) && apiKey) {
      if (project && project.mode === "sandbox") {
        const home = ensureProjectHome(project);
        // Refresh credentials in the project's sandbox-platform.json exactly
        // like the new-session path (container binding is already recorded).
        writeSandboxConfig(home, { apiKey });
        effectiveCwd = home;
      } else {
        // Pre-project sandbox session: refresh the user's stub home config.
        effectiveCwd = ensureSandboxHome(user.id, {
          url: process.env.PI_WEB_PLATFORM_URL,
          apiKey,
          disableLocalFallback: true,
        });
      }
      additionalExtensionPaths = [extPath];
      extensionFactories = [
        makeRemoteVerifyExtension("sandbox", meta?.ownerId ?? user.id),
        makeEnvironmentInfoExtension({
          mode: "sandbox",
          username: identity.session.user.username,
          ...(project ? { projectName: project.name } : {}),
        }),
      ];
    }
  } else if (mode === "local-machine") {
    if (getAgentForUser(meta?.ownerId ?? user.id)?.info) {
      if (project && project.mode === "local-machine") {
        effectiveCwd = ensureProjectHome(project);
      } else {
        effectiveCwd = ensureLocalHome(user.id);
      }
      extensionFactories = [
        makeRelayToolsExtension(meta?.ownerId ?? user.id),
        makeRemoteVerifyExtension("local-machine", meta?.ownerId ?? user.id),
        makeEnvironmentInfoExtension({
          mode: "local-machine",
          username: identity.session.user.username,
          ...(project ? { projectName: project.name } : {}),
        }),
      ];
    }
  } else {
    extensionFactories = [makeEnvironmentInfoExtension({ mode: "host", username: identity.session.user.username })];
  }

  const ownerId = meta?.ownerId ?? user.id;
  return {
    ...(additionalExtensionPaths ? { additionalExtensionPaths } : {}),
    ...(extensionFactories ? { extensionFactories } : {}),
    ...(ownerId !== 0 ? { ownerId } : {}),
    mode,
    // Project-scoped model credentials live in the project home's .pi/.
    ...(effectiveCwd && project ? { projectCredentialDir: effectiveCwd } : {}),
  };
}
