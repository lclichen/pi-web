/**
 * 项目行“机器徽标”的纯函数（零依赖，客户端可安全 import）。
 *
 * 单独成文件的原因：状态判定要被组件和单测共用，而 `lib/relay/registry.ts`
 * 带 ws/node 依赖，客户端只能 import type——所以这里只接受结构化的机器快照。
 */

import { DEFAULT_MACHINE_ID } from "./relay/protocol";

/** 状态判定需要的机器目录字段（`MachineStatus` 的子集）。 */
export interface MachineBadgeMachineLike {
  machineId: string;
  label?: string;
  online: boolean;
  /** 在线机器的客户端版本判定：false = 需要升级客户端。 */
  compatible?: boolean;
  requiredVersion?: string;
  /** 最后一次在线时间（ISO 字符串，来自持久化 token 记录）。 */
  lastSeenAt?: string;
  hostname?: string;
}

/** 状态判定需要的项目字段（`ProjectRecord` 的子集）。 */
export interface MachineBadgeProjectLike {
  mode?: string;
  /** 空 = legacy 项目，使用该用户的默认机器。 */
  machineId?: string;
}

/** online = 在线；offline = 已配对但离线；unpaired = 机器目录里找不到。 */
export type MachineBadgeStatus = "online" | "offline" | "unpaired";

export interface MachineBadgeState {
  machineId: string;
  status: MachineBadgeStatus;
  /** 显示名：label → hostname → machineId 前 8 位（与 getMachinesForUser 一致）。 */
  name: string;
  /** 在线但客户端版本过低（compatible === false）。 */
  upgradeRequired: boolean;
  requiredVersion?: string;
  /** 离线机器的最后在线时间（已校验可解析后再传递）。 */
  lastSeenAt?: string;
}

/** 机器显示名回退：label → hostname → machineId 前 8 位。 */
export function machineDisplayName(machine: MachineBadgeMachineLike): string {
  return machine.label || machine.hostname || machine.machineId.slice(0, 8);
}

/**
 * 本机模式项目的机器徽标状态。
 * - 非本机模式（sandbox/ssh/host/quick）→ null，不显示徽标；
 * - 机器目录尚未到达（`machines` 为 undefined）→ null，避免先闪一下「已解配」；
 * - 找不到 `project.machineId` → unpaired（重新配对会生成全新 machineId，
 *   旧 id 再也匹配不上任何机器）；
 * - `machineId` 为空是 legacy 项目，按默认机器（"default"）判定。
 */
export function machineBadgeState(
  project: MachineBadgeProjectLike | null | undefined,
  machines: readonly MachineBadgeMachineLike[] | null | undefined,
): MachineBadgeState | null {
  if (!project || project.mode !== "local-machine") return null;
  if (!machines) return null;
  const machineId = project.machineId || DEFAULT_MACHINE_ID;
  const machine = machines.find((m) => m.machineId === machineId);
  if (!machine) {
    return { machineId, status: "unpaired", name: machineId.slice(0, 8), upgradeRequired: false };
  }
  const upgradeRequired = machine.compatible === false;
  const lastSeenAt =
    machine.lastSeenAt && !Number.isNaN(Date.parse(machine.lastSeenAt)) ? machine.lastSeenAt : undefined;
  return {
    machineId,
    status: machine.online ? "online" : "offline",
    name: machineDisplayName(machine),
    upgradeRequired,
    ...(upgradeRequired && machine.requiredVersion ? { requiredVersion: machine.requiredVersion } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
  };
}
