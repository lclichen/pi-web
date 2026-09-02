/**
 * Session execution modes (design doc §2): where the session's tools run.
 * The agent process always lives in pi-web; only the tool layer differs.
 */

export type SessionMode = "host" | "sandbox" | "local-machine" | "ssh";

export function isSessionMode(value: unknown): value is SessionMode {
  return value === "host" || value === "sandbox" || value === "local-machine" || value === "ssh";
}

export interface ModeActor {
  id: number;
  role: "admin" | "user";
}

/**
 * Mode permissions:
 *  - host: admin only (full server-local access)
 *  - sandbox: any logged-in user (requires PI_WEB_PLATFORM_URL)
 *  - local-machine: any logged-in user (requires a relay bound to them)
 *  - ssh: any logged-in user (credentials live in their own project config)
 */
export function modeAllowedForUser(mode: SessionMode, actor: ModeActor): { ok: true } | { ok: false; reason: string } {
  if (actor.id === 0) {
    // Auth off: single implicit host admin — every mode is available,
    // though sandbox/local-machine still need their env wiring.
    return { ok: true };
  }
  if (mode === "host" && actor.role !== "admin") {
    return { ok: false, reason: "Host 模式仅管理员可用" };
  }
  return { ok: true };
}

export const MODE_LABELS: Record<SessionMode, string> = {
  host: "Host",
  sandbox: "沙箱",
  "local-machine": "本机",
  ssh: "SSH",
};
