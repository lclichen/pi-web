import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { makeRelayToolsExtension } from "./extensions/relay-tools";
import { makeSshToolsExtension } from "./extensions/ssh-tools";
import { makeSandboxToolsExtension } from "./extensions/sandbox-tools";
import { makeEnvironmentInfoExtension } from "./extensions/environment-info";
import { makeRemoteVerifyExtension } from "./extensions/remote-verify";
import { resolveSessionMode } from "./session-metas";
import { getOwnedProject, ensureProjectHome, type ProjectRecord } from "./projects";
import { readSshConfig } from "./ssh";
import { sessionDirsForProject } from "./session-context";

/**
 * 子智能体内联扩展桥（tintinweb ↔ pi-web）。
 *
 * 父会话的模式扩展（relay-tools / ssh-tools / remote-verify /
 * environment-info）是创建/恢复时注入的内联工厂（闭包绑定 userId 等），
 * tintinweb 直接经 SDK 建子会话不经过 pi-web 路由——内联扩展天然丢失，
 * 子智能体的编码工具会落到 pi-web 服务器本机执行（沙箱模式的容器工具
 * 例外：它是文件发现式，子会话能自己加载）。
 *
 * 统一修法：tintinweb 在创建子会话的 loader 里查询
 * `globalThis.__piWebChildExtensions(parentSessionId)`（fork 侧 ~15 行，
 * 无钩子时 CLI 行为不变）；本模块提供该钩子——按父会话的模式返回同一套
 * 工厂，子会话与父会话在同一后端执行。桥在进程内调用（同一 Next 进程），
 * 打包产物同样可用，且父会话本身不经此路径（无双重注册）。
 *
 * 循环依赖规避：本模块不 import rpc-manager——rpc-manager 以安装器注入
 * 查询函数（lookup），桥只消费。
 */

export interface SubagentParentInfo {
  mode: "host" | "sandbox" | "local-machine" | "ssh" | "quick";
  ownerId: number;
  /** 父会话 cwd（服务器侧项目目录）。 */
  cwd: string;
}

type ParentLookup = (parentSessionId: string) => SubagentParentInfo | undefined;

declare global {
  // eslint-disable-next-line no-var
  var __piWebChildExtensions: ((parentSessionId: string) => InlineExtension[] | undefined) | undefined;
}

/**
 * Build the child's extension set for a live parent. Mirrors the parent's
 * creation/restore injection per mode (agent/new + session-restore-options),
 * minus the pieces children already get by other means (sandbox container
 * tools via file discovery; global packages via the agent dir).
 */
export function childExtensionsFor(
  info: SubagentParentInfo,
  meta: { projectId?: string; ownerName?: string } | undefined,
): InlineExtension[] | undefined {
  const project: ProjectRecord | undefined = meta?.projectId
    ? getOwnedProject(meta.projectId, info.ownerId, true)
    : undefined;
  const username = meta?.ownerName ?? `u${info.ownerId}`;

  switch (info.mode) {
    case "local-machine": {
      if (project && project.mode === "local-machine") {
        const home = ensureProjectHome(project);
        const dirs = sessionDirsForProject(project, home);
        return [
          makeRelayToolsExtension(info.ownerId, {
            projectHome: home,
            ...(project.workdir ? { workspaceDir: project.workdir } : {}),
            ...(project.machineId ? { machineId: project.machineId } : {}),
          }),
          makeRemoteVerifyExtension("local-machine", info.ownerId),
          makeEnvironmentInfoExtension({
            mode: "local-machine",
            username,
            projectName: project.name,
            workspaceDir: dirs.workspaceDir,
          }),
        ];
      }
      return [
        makeRelayToolsExtension(info.ownerId),
        makeRemoteVerifyExtension("local-machine", info.ownerId),
        makeEnvironmentInfoExtension({ mode: "local-machine", username }),
      ];
    }
    case "ssh": {
      if (project && project.mode === "ssh") {
        const home = ensureProjectHome(project);
        const sshConfig = readSshConfig(home);
        if (sshConfig) {
          return [
            makeSshToolsExtension({
              projectId: project.id,
              sshConfig,
              workdir: project.workdir ?? "/",
              projectHome: home,
            }),
            makeEnvironmentInfoExtension({
              mode: "ssh",
              username,
              projectName: project.name,
              workspaceDir: project.workdir ?? "/",
            }),
          ];
        }
      }
      return undefined; // ssh 会话必有项目与配置；缺失说明父会话已坏，不注入
    }
    case "sandbox": {
      return [
        // Container tool routing for child sessions: pre-merge children got
        // the sandbox extension via .pi/extensions file discovery in the
        // project home; post-merge that link is removed, so the factory
        // rides the inline bridge like every other mode tool layer.
        makeSandboxToolsExtension(),
        makeRemoteVerifyExtension("sandbox", info.ownerId),
        makeEnvironmentInfoExtension({
          mode: "sandbox",
          username,
          ...(project?.name ? { projectName: project.name } : {}),
          ...(project && project.containerId !== undefined && project.containerId !== null
            ? { containerId: Number(project.containerId) }
            : {}),
        }),
      ];
    }
    case "host": {
      return [makeEnvironmentInfoExtension({ mode: "host", username, hostDir: info.cwd })];
    }
    default:
      // quick：父会话本就不注入模式扩展（模板自身约束），保持一致。
      return undefined;
  }
}

/** Install the spawn hook. Called once by rpc-manager with its live lookup. */
export function installSubagentBridge(lookup: ParentLookup): void {
  globalThis.__piWebChildExtensions = (parentSessionId: string): InlineExtension[] | undefined => {
    try {
      const info = lookup(parentSessionId);
      if (!info) return undefined; // 父会话不在本进程活动注册表（CLI/孙代）：不注入
      return childExtensionsFor(info, resolveSessionMode(parentSessionId));
    } catch {
      return undefined; // 桥自身故障绝不阻断 spawn——宁可少注入不可坏会话
    }
  };
}
