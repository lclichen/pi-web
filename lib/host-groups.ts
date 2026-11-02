/**
 * Host 目录分组的纯函数（零依赖，客户端可安全 import）。
 *
 * 单独成文件的原因：`lib/host-dirs.ts` 带 node:fs（服务端存储），客户端
 * 组件只能 import type；而分组逻辑需要被两侧共用并被单测直接加载。
 */

/** 侧栏分组需要的会话最小形状（SessionInfo 的子集）。 */
export interface HostGroupSessionLike {
  mode?: string;
  projectRoot?: string;
  cwd: string;
  modified: string;
}

export interface HostGroupDirLike {
  root: string;
}

/** 目录末级名（POSIX 与 Windows 反斜杠都支持；客户端/服务端共用）。 */
export function hostDirLabel(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : root;
}

/**
 * Host 目录分组：会话按 projectRoot（回退 cwd）聚合，注册表里的空目录补
 * 一个空组。有会话的组按最近会话排序，空组排在后面（`""` 字典序最小）。
 */
export function buildHostGroups<T extends HostGroupSessionLike>(
  ungrouped: readonly T[],
  dirs: readonly HostGroupDirLike[],
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const session of ungrouped) {
    if (session.mode && session.mode !== "host") continue;
    const key = session.projectRoot ?? session.cwd;
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  for (const dir of dirs) {
    if (!groups.has(dir.root)) groups.set(dir.root, []);
  }
  return [...groups.entries()].sort((a, b) => {
    const latest = (entry: [string, T[]]) => entry[1][0]?.modified ?? "";
    return latest(b).localeCompare(latest(a));
  });
}
