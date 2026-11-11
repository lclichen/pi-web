/**
 * Server-side workspace provider for a project record.
 *
 * Used by non-session project actions (config sync) that need the same
 * execution channel and path containment as the project's session tools.
 * Deliberately reuses the mode gate checks: relay agent compatibility, SSH
 * credentials, sandbox credential/container resolution.
 */
import { PlatformClient } from "../pi-config/agent/extensions/amedac-core/src/sandbox/client.ts";
import { createSandboxWorkspaceOperations } from "../pi-config/agent/extensions/amedac-core/src/sandbox/workspace-provider.ts";
import { platformGet, platformUrl } from "./platform/client.ts";
import { getSshClient, readSshConfig } from "./ssh.ts";
import { requireCompatibleAgent } from "./relay/agent-gate.ts";
import { resolveRelayWorkspaceScope } from "./relay/workspace-base.ts";
import { createRelayWorkspaceOperations } from "./workspace-providers/relay.ts";
import { createSshWorkspaceOperations } from "./workspace-providers/ssh.ts";
import { readSandboxHomeConfig } from "./mode-homes.ts";
import { ensureProjectHome, readProjectSandboxConfig, type ProjectRecord } from "./projects.ts";
import type { WorkspaceOperations } from "./workspace-operations.ts";

export type ProjectWorkspaceResult =
  { ok: true; workspace: WorkspaceOperations } | { ok: false; status: number; error: string };

interface PlatformContainer {
  id: number;
  name: string;
}

async function resolveSandboxContainer(
  project: ProjectRecord,
  userId: number,
  apiKey: string,
): Promise<ProjectWorkspaceResult | number> {
  let containerId = Number(project.containerId ?? 0) || Number(readProjectSandboxConfig(project).containerId ?? 0) || 0;
  if (!containerId) {
    const userDefault = Number(readSandboxHomeConfig(userId).containerId) || 0;
    containerId = userDefault;
  }
  if (!containerId) {
    try {
      const list = await platformGet<{ containers?: PlatformContainer[] }>("/api/v1/containers", apiKey, {
        filter: "running",
      });
      const running = list.containers ?? [];
      if (running.length === 1) containerId = running[0].id;
      else if (running.length > 1) {
        return {
          ok: false,
          status: 409,
          error: `有 ${running.length} 个容器在运行（${running.map((c) => `#${c.id} ${c.name}`).join("、")}），请先在项目菜单中绑定一个容器`,
        };
      }
    } catch {
      // fall through to the explicit error
    }
  }
  if (!containerId) {
    return { ok: false, status: 409, error: "项目没有可用的沙箱容器——请先在项目菜单中绑定或启动一个容器" };
  }
  return containerId;
}

/**
 * Resolve a project's remote workspace. `apiKey` is the caller's platform
 * credential (sandbox mode only); it is never persisted by this helper.
 */
export async function createProjectWorkspaceOperations(
  project: ProjectRecord,
  user: { id: number; role: string },
  apiKey: string,
): Promise<ProjectWorkspaceResult> {
  if (project.mode === "sandbox") {
    if (!process.env.PI_WEB_PLATFORM_URL) {
      return { ok: false, status: 400, error: "沙箱模式未配置（缺少 PI_WEB_PLATFORM_URL）" };
    }
    if (!apiKey) return { ok: false, status: 401, error: "沙箱模式需要平台凭证，请重新登录" };
    const config = readProjectSandboxConfig(project);
    const resolved = await resolveSandboxContainer(project, user.id, apiKey);
    if (typeof resolved !== "number") return resolved;
    let baseUrl: string;
    try {
      baseUrl = (config.url || platformUrl()).replace(/\/+$/, "");
    } catch (e) {
      return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
    }
    const client = new PlatformClient({ url: baseUrl, apiKey });
    return {
      ok: true,
      workspace: createSandboxWorkspaceOperations({
        getClient: () => client,
        getContainerId: () => Promise.resolve(resolved),
      }),
    };
  }

  if (project.mode === "local-machine") {
    const gate = requireCompatibleAgent(user.id, project.machineId);
    if (!gate.ok) return { ok: false, status: gate.status, error: gate.error };
    if (project.workdir) {
      const scope = resolveRelayWorkspaceScope(project.workdir, gate.info);
      if (scope.error) return { ok: false, status: 409, error: scope.error };
    }
    return {
      ok: true,
      workspace: createRelayWorkspaceOperations({
        userId: user.id,
        ...(project.workdir ? { workspaceDir: project.workdir } : {}),
        ...(project.machineId ? { machineId: project.machineId } : {}),
      }),
    };
  }

  if (project.mode === "ssh") {
    const home = ensureProjectHome(project);
    const sshConfig = readSshConfig(home);
    if (!sshConfig) return { ok: false, status: 400, error: "SSH 项目缺少连接配置（.pi/ssh.json 缺失）" };
    return {
      ok: true,
      workspace: createSshWorkspaceOperations({
        getClient: () => getSshClient(project.id, sshConfig),
        workdir: project.workdir ?? "/",
      }),
    };
  }

  return { ok: false, status: 400, error: `项目模式 ${project.mode} 没有远程工作区` };
}
