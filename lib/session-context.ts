import { ensureProjectHome, type ProjectRecord } from "./projects";
import type { SessionMode } from "./session-modes";

/**
 * 会话目录契约：项目目录（projectDir）与工作区目录（workspaceDir）的划分。
 *
 * projectDir（项目目录，服务器侧）——pi SDK 会话的 cwd。扩展、Skills、
 * AGENTS.md、.pi/ 配置（MCP / 模型）全部从这里加载，由框架保证：
 *   · SDK 原生按会话 cwd 做资源发现；
 *   · local-machine / ssh 模式下，工具对 .pi/skills 与 AGENTS.md 的读取
 *     由服务端桥接（relay-tools 的 localSkillsPath / ssh-tools 的同级
 *     映射）落回 projectDir——这两类资源永远不进远端工作区。
 *
 * workspaceDir（工作区目录，按模式）——模型实际操作文件、执行命令的位置：
 *   host           服务器目录本身（此时项目目录 = 工作区目录）
 *   sandbox        平台容器内 /workspace（文件由项目目录同步）
 *   ssh            远程主机上的项目工作目录（project.workdir）
 *   local-machine  用户本机上的项目工作区（project.workdir；未绑定 = agent 共享根）
 *   quick          服务器侧快速会话 scratch home（两者重合）
 *
 * 三个使用点：
 *   1. 会话创建（agent/new）与恢复（session-restore-options）：SDK 会话
 *      cwd 一律 = projectDir。project.workdir 是工作区概念，绝不能当会话
 *      cwd（曾被误用：SDK 在服务器上把它 resolve 成 `<repo>/D:\…` 混合
 *      路径写进会话头，恢复即崩）。
 *   2. 提示词（environment-info）：把两个目录明确告知模型——它"在哪里
 *      运行、能操作哪些文件"看 workspaceDir，"配置/Skills 从哪来"看
 *      projectDir。
 *   3. 命令执行与文件路径参数：由各模式的工具映射层负责把 projectDir
 *      语义（配置读取）与 workspaceDir 语义（文件操作）路由到正确后端。
 */

export type WorkspaceKind = "server" | "container" | "remote-ssh" | "local-agent";

export interface SessionDirs {
  mode: SessionMode;
  /** 服务器侧项目目录：SDK 会话 cwd，资源加载的唯一来源。 */
  projectDir: string;
  /** 工作区目录（可能是远端/容器路径，仅用于提示词与映射层）。 */
  workspaceDir: string;
  workspaceKind: WorkspaceKind;
}

/**
 * 项目型会话的目录解析。home = ensureProjectHome(project) 的结果
 *（调用方已有）；本函数不触盘、不创建目录，纯映射。
 */
export function sessionDirsForProject(project: ProjectRecord, home: string): SessionDirs {
  switch (project.mode) {
    case "sandbox":
      return { mode: project.mode, projectDir: home, workspaceDir: "/workspace", workspaceKind: "container" };
    case "ssh":
      return { mode: project.mode, projectDir: home, workspaceDir: project.workdir ?? "/", workspaceKind: "remote-ssh" };
    case "local-machine":
      return {
        mode: project.mode,
        projectDir: home,
        // 未绑定 workdir = 用户本机共享根（相对路径，relay 端懒创建）。
        workspaceDir: project.workdir ?? "（本机共享工作区根）",
        workspaceKind: "local-agent",
      };
    default:
      // 项目表里不该出现的模式；按 host 语义兜底，绝不猜远端路径。
      return { mode: "host", projectDir: home, workspaceDir: home, workspaceKind: "server" };
  }
}

/** 非项目会话（host 直开目录 / quick scratch home）的目录解析。 */
export function sessionDirsForStandalone(mode: SessionMode, dir: string): SessionDirs {
  if (mode === "quick") {
    return { mode, projectDir: dir, workspaceDir: dir, workspaceKind: "server" };
  }
  // host：服务器目录本身就是项目目录与工作区。
  return { mode: "host", projectDir: dir, workspaceDir: dir, workspaceKind: "server" };
}

/** 从项目记录直接解析（内部调用 ensureProjectHome，适合创建点）。 */
export function sessionDirsForNewProject(project: ProjectRecord): SessionDirs {
  return sessionDirsForProject(project, ensureProjectHome(project));
}
