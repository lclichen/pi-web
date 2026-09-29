import { existsSync } from "fs";
import { join } from "path";
import { getAgentDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { RpcSessionStartOptions } from "./rpc-manager";
import { getSessionMeta } from "./session-metas";
import { ensureProjectHome, getOwnedProject, projectHome, writeSandboxConfig } from "./projects";
import { ensureLocalHome, ensureSandboxHome, ensureQuickHome } from "./mode-homes";
import { spaceDir } from "./session-spaces";
import { makeRelayToolsExtension } from "./extensions/relay-tools";
import { makeRemoteVerifyExtension } from "./extensions/remote-verify";
import { makeEnvironmentInfoExtension } from "./extensions/environment-info";
import { makeSshToolsExtension } from "./extensions/ssh-tools";
import { makeBgTasksExtension } from "./extensions/bg-tasks";
import { registerBgChannel } from "./extensions/bg-shell";
import { makeRelayBgChannel, makeSandboxBgChannel, makeSshBgChannel } from "./extensions/bg-channels";
import { readSshConfig } from "./ssh";
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
      // bg-shell channel: sandbox tasks run INSIDE the container via the
      // platform tools/bash API. Pre-project sessions have no container yet —
      // a rejecting stub keeps bg_run from falling back to a server-side
      // local spawn (wrong host, potential sandbox escape).
      registerBgChannel(
        sessionId,
        project && project.containerId !== undefined
          ? makeSandboxBgChannel(apiKey, project.containerId)
          : {
              label: "sandbox",
              kind: "remote" as const,
              run: async () => {
                throw new Error("容器尚未创建——先发送首条消息启动沙箱会话，再使用后台任务");
              },
            },
      );
    }
  } else if (mode === "local-machine") {
    if (getAgentForUser(meta?.ownerId ?? user.id)?.info) {
      if (project && project.mode === "local-machine") {
        effectiveCwd = ensureProjectHome(project);
      } else {
        effectiveCwd = ensureLocalHome(user.id);
      }
      extensionFactories = [
        makeRelayToolsExtension(meta?.ownerId ?? user.id, project ? effectiveCwd : undefined),
        makeRemoteVerifyExtension("local-machine", meta?.ownerId ?? user.id),
        makeEnvironmentInfoExtension({
          mode: "local-machine",
          username: identity.session.user.username,
          ...(project ? { projectName: project.name } : {}),
        }),
      ];
      // bg-shell channel: tasks run on the user's paired machine via relay
      // exec.run (nohup pattern); machine follows the project binding.
      registerBgChannel(sessionId, makeRelayBgChannel(meta?.ownerId ?? user.id, project?.machineId ?? undefined));
    }
  } else if (mode === "ssh") {
    // SSH mode: the SDK session runs server-side in the project home; the
    // ssh-tools extension routes the seven coding tools to the remote host.
    // Requires the SSH config the project was created with.
    if (project && project.mode === "ssh") {
      effectiveCwd = ensureProjectHome(project);
      const sshConfig = readSshConfig(effectiveCwd);
      if (sshConfig) {
        extensionFactories = [
          makeSshToolsExtension({ projectId: project.id, sshConfig, workdir: project.workdir ?? "/", projectHome: effectiveCwd }),
          makeEnvironmentInfoExtension({
            mode: "ssh",
            username: identity.session.user.username,
            ...(project ? { projectName: project.name } : {}),
          }),
        ];
        // bg-shell channel: tasks run on the remote host via the pooled
        // client (nohup pattern), same connection the ssh-tools use.
        registerBgChannel(sessionId, makeSshBgChannel(project.id, sshConfig, project.workdir ?? "/"));
      }
    }
  } else if (mode === "quick") {
    // Quick mode on restore: same scratch home, same tool policy. The system
    // prompt rides the session file itself (persisted as a model_change-adjacent
    // context), so only the tool set needs rebuilding.
    effectiveCwd = ensureQuickHome(user.id);
  } else {
    extensionFactories = [makeEnvironmentInfoExtension({ mode: "host", username: identity.session.user.username })];
  }

  const ownerId = meta?.ownerId ?? user.id;
  const coreExtensionPaths = resolveCoreExtensionPaths(additionalExtensionPaths);
  return {
    ...(coreExtensionPaths ? { additionalExtensionPaths: coreExtensionPaths } : {}),
    // The core session extensions (todo / plan_save / plan-mode) load via the
    // global agent dir's amedac-core package — the SAME source the pi CLI
    // distribution ships, so CLI and WebUI stay behaviorally identical
    // (single source of truth in pi-config/agent/extensions/amedac-core).
    // They must NOT also be injected as inline factories: tools dedupe by
    // "last registration wins" while both copies' event handlers would run.
    // Only server-coupled extensions stay inline here.
    extensionFactories: [makeBgTasksExtension(), ...(extensionFactories ?? [])],
    ...(ownerId !== 0 ? { ownerId } : {}),
    mode,
    ...(mode === "quick" ? { quick: {} } : {}),
    // Project-scoped model credentials live in the project home's .pi/.
    ...(effectiveCwd && project ? { projectCredentialDir: effectiveCwd } : {}),
  };
}

/**
 * amedac-core fallback for source deployments: packaged deployments link the
 * pi-config template into the global agent dir (install-pi-config.sh), so
 * discovery finds it there and this returns nothing extra. A bare source
 * checkout (npm-run dev / /opt/pi-web without the offline package) never ran
 * the installer — point discovery at the repo's bundled copy instead, but
 * ONLY when the agent dir does not already provide it (never both paths:
 * double registration silently overwrites tools and runs both copies'
 * event handlers).
 */
export function resolveCoreExtensionPaths(existing?: string[]): string[] | undefined {
  try {
    const installed = join(getAgentDir(), "extensions", "amedac-core");
    if (existsSync(join(installed, "package.json"))) return existing;
    const bundled = join(process.cwd(), "pi-config", "agent", "extensions", "amedac-core");
    if (existsSync(join(bundled, "package.json"))) return [...(existing ?? []), bundled];
  } catch {
    // best-effort — sessions degrade to no core extensions
  }
  return existing;
}
