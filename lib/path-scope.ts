/**
 * 远程会话的路径空间标记（`.pi/path-policy.scope.json`）。
 *
 * sandbox / ssh / local-machine 会话的 SDK cwd 是服务器侧项目 home，但工具
 * 路径是远端工作区路径（/workspace/… 或用户机器上的绝对目录）。路径护栏
 * （amedac-core）读这个文件把远端工作区根映射回项目 home，使 deny/allow
 * 规则（相对 glob）在四种模式下语义一致。
 *
 * 运行态文件：不导出进配置包（DENIED_BASENAMES），Agent 工具不可写
 * （SELF_PROTECTED_PATTERNS）。Host / quick 不需要标记。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATH_SCOPE_FILE, type PathScope } from "./extensions/path-guard";

export interface PathScopeInput {
  mode: PathScope["mode"];
  /** 工具路径空间里的工作区绝对路径（远端）；缺省/"/" 表示不做映射。 */
  workspaceRoot?: string | null;
}

/** 规范化远端根：反斜杠转正斜杠、折叠重复分隔符、去尾斜杠；"/" 视为无围栏。 */
export function normalizeWorkspaceRoot(root: string | null | undefined): string | null {
  const trimmed = root?.trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  // UNC 路径（//server/share）保留双斜杠前缀。
  const collapsed = trimmed.startsWith("//") ? `//${trimmed.slice(2).replace(/\/{2,}/g, "/")}` : trimmed.replace(/\/{2,}/g, "/");
  const value = collapsed.replace(/\/+$/, "");
  if (!value || value === "/") return null;
  return value;
}

/** 写路径空间标记（best-effort：写不进不影响会话）。 */
export function writePathScope(home: string, input: PathScopeInput): boolean {
  const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot);
  if (!workspaceRoot) return false;
  const target = join(home, PATH_SCOPE_FILE);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ version: 1, mode: input.mode, workspaceRoot }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 由会话模式推导路径空间根：
 *  · sandbox：容器内工作区恒为 /workspace；
 *  · ssh / local-machine：项目工作区（project.workdir）。
 * Host / quick 返回 null。
 */
export function pathScopeForSession(
  mode: string,
  project: { mode?: string; workdir?: string } | undefined,
): PathScopeInput | null {
  if (mode === "sandbox") return { mode: "sandbox", workspaceRoot: "/workspace" };
  if (mode === "ssh" || mode === "local-machine") {
    return { mode, workspaceRoot: project?.workdir ?? null };
  }
  return null;
}
