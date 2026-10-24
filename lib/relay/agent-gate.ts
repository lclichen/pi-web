/**
 * Runtime gate for local-machine operations: the paired client must be
 * online AND recent enough for this WebUI (see lib/client-compat.ts).
 */
import { clientCompatibility, REQUIRED_CLIENT_VERSION } from "../client-compat";
import type { AgentInfo } from "./protocol";
import { getAgentForUser } from "./registry";

export type AgentGateResult =
  | { ok: true; info: AgentInfo; machineId: string }
  | { ok: false; status: 400 | 503; error: string };

export function requireCompatibleAgent(
  userId: number,
  machineId?: string,
  options: { requireCompatible?: boolean } = {},
): AgentGateResult {
  const conn = getAgentForUser(userId, machineId);
  if (!conn?.info) {
    return {
      ok: false,
      status: 503,
      error: machineId ? "项目绑定的机器不在线" : "本机未连接（relay 离线）",
    };
  }
  if (options.requireCompatible !== false) {
    const compat = clientCompatibility(conn.info.agentVersion);
    if (!compat.compatible) {
      return {
        ok: false,
        status: 400,
        error: compat.message ?? `客户端版本过低，需要 ≥ ${REQUIRED_CLIENT_VERSION}`,
      };
    }
  }
  return { ok: true, info: conn.info, machineId: conn.machineId };
}
