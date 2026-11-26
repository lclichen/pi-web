/**
 * 「重新连接机器」的纯函数（零依赖，客户端可安全 import）。
 *
 * 与 `lib/machine-badge.ts` 同因：判定/排序/提交体形状要被组件和单测共用，
 * 而 `lib/relay/registry.ts` 带 ws/node 依赖，客户端只能 import type——所以
 * 这里只接受结构化的机器快照与项目子集。
 */

import { machineBadgeState, machineDisplayName } from "./machine-badge";
import type { MachineBadgeMachineLike, MachineBadgeProjectLike } from "./machine-badge";

/**
 * 本机模式项目是否需要「重新连接机器」入口：徽标为 unpaired（机器已解配）
 * 或 offline（绑定机器当前离线）。机器目录未到达（undefined）时不做判定。
 */
export function needsMachineReconnect(
  project: MachineBadgeProjectLike | null | undefined,
  machines: readonly MachineBadgeMachineLike[] | null | undefined,
): boolean {
  const badge = machineBadgeState(project, machines);
  return badge?.status === "unpaired" || badge?.status === "offline";
}

/**
 * 机器选择列表排序：在线优先（与向导的绿点/灰点一致），同状态按显示名。
 * 不修改入参（调用方常直接传 hook 返回的数组）。
 */
export function sortReconnectMachines<T extends MachineBadgeMachineLike>(machines: readonly T[]): T[] {
  return [...machines].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return machineDisplayName(a).localeCompare(machineDisplayName(b));
  });
}

/**
 * 重连 PATCH 的 body：`{ machineId, workdir? }`。workdir 总是带上（服务端
 * 会在**新机器**上校验——同一请求里换机器 + 换目录正是「重新连接」的典型
 * 形态）；空目录则省略，避免把项目的 workdir 清掉。
 */
export function buildMachineReconnectPatch(
  machineId: string,
  workdir: string,
): { machineId: string; workdir?: string } {
  const dir = workdir.trim();
  return { machineId, ...(dir ? { workdir: dir } : {}) };
}

/**
 * 侧栏「上线提示」计数：有一台机器在线、且存在绑定机器已解配的本机项目时
 * 返回这些项目的数量；否则 0。只用于提示——绝不据此自动改绑（用户可能换
 * 了物理机器，自动指过去会连到错误的机器）。
 */
export function countUnpairedMachineProjects(
  projects: readonly MachineBadgeProjectLike[],
  machines: readonly MachineBadgeMachineLike[] | null | undefined,
): number {
  if (!machines || !machines.some((m) => m.online)) return 0;
  let count = 0;
  for (const project of projects) {
    if (machineBadgeState(project, machines)?.status === "unpaired") count += 1;
  }
  return count;
}
