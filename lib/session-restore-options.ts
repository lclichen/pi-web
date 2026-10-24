import { existsSync } from "fs";
import { join } from "path";
import { getAgentDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { RpcSessionStartOptions } from "./rpc-manager";
import { resolveSessionMode } from "./session-metas";
import { ensureProjectHome, getOwnedProject, projectHome, writeSandboxConfig } from "./projects";
import { ensureLocalHome, ensureSandboxHome, ensureQuickHome } from "./mode-homes";
import { quickSessionDir, readQuickTemplateSnapshot } from "./quick-session";
import { syncQuickMcpConfig } from "./quick-mcp";
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

  const meta = resolveSessionMode(sessionId);
  // 项目记录的模式高于过期 sidecar meta（lib/session-metas.ts）。
  const mode = meta?.mode ?? "host";
  const project = meta?.projectId ? getOwnedProject(meta.projectId, meta.ownerId ?? user.id, user.role === "admin") : undefined;

  let additionalExtensionPaths: string[] | undefined;
  let quickForRestore: { systemPrompt?: string; model?: { provider: string; modelId: string }; mcpServers?: string[] } | undefined;
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
    // Always inject the relay tool layer — even when the client is offline or
    // outdated. Each tool call then fails with an explicit relay/version error
    // instead of silently falling back to the SERVER's built-in tools.
    if (project && project.mode === "local-machine") {
      effectiveCwd = ensureProjectHome(project);
    } else {
      effectiveCwd = ensureLocalHome(user.id);
    }
    extensionFactories = [
      makeRelayToolsExtension(meta?.ownerId ?? user.id, {
        ...(project ? { projectHome: effectiveCwd } : {}),
        ...(project?.workdir ? { workspaceDir: project.workdir } : {}),
        ...(project?.machineId ? { machineId: project.machineId } : {}),
      }),
      makeRemoteVerifyExtension("local-machine", meta?.ownerId ?? user.id),
      makeEnvironmentInfoExtension({
        mode: "local-machine",
        username: identity.session.user.username,
        ...(project ? { projectName: project.name } : {}),
        ...(project?.workdir ? { workspaceDir: project.workdir } : {}),
      }),
    ];
    // bg-shell channel: tasks run on the user's paired machine via relay
    // exec.run (nohup pattern); machine follows the project binding.
    registerBgChannel(sessionId, makeRelayBgChannel(meta?.ownerId ?? user.id, project?.machineId ?? undefined, project?.workdir));
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
    // 每会话独立工作区（meta.quickDir → lib/quick-session.ts）；旧会话回落
    // 共享 quick home。恢复优先用模板快照（创建时的确切内容），而非活模板。
    const quickSlug = (meta as { quickDir?: string } | undefined)?.quickDir;
    effectiveCwd = quickSlug ? quickSessionDir(user.id, quickSlug) : ensureQuickHome(user.id);
    const snapshot = quickSlug ? readQuickTemplateSnapshot(effectiveCwd) : null;
    const { getQuickTemplate } = await import("./quick-templates");
    const template = snapshot ?? (meta?.templateId ? getQuickTemplate(meta.templateId) : undefined);
    if (template) {
      quickForRestore = {
        ...(template.systemPrompt ? { systemPrompt: template.systemPrompt } : {}),
        ...(template.model ? { model: template.model } : {}),
        ...(template.mcpServers && template.mcpServers.length > 0 ? { mcpServers: template.mcpServers } : {}),
      };
    }
    // 部署级 quick MCP 变更后，恢复时刷新会话工作区里的物化副本
    if (quickSlug) syncQuickMcpConfig(user.id, effectiveCwd);
    // 恢复时按 meta.templateId 重建 quick 选项：quickToolSet（MCP 白名单）与
    // 提示词扩展（模板附加）都挂在 quick 选项上——不重建则恢复的快速会话
    // 丢工具策略与模板提示词。

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
    ...(mode === "quick" ? { quick: quickForRestore ?? {} } : {}),
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
