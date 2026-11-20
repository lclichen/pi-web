import { join } from "node:path";
import { dataDir } from "./mode-homes";
import { stateDir } from "./state/paths";

/**
 * Per-user configuration roots.
 *
 * JSON config sources live under state/users/u<id>/pi (pi-native settings,
 * MCP, models, auth) plus state/users/u<id>/push.json. File-based resources
 * (skills/agents/plugins) deliberately remain under data/user-config/u<id>.
 * user id 0 is the auth-off implicit host identity; callers keep using the
 * global agent directory for that case (see `isUserScopedConfig`).
 */

export function userStateRoot(userId: number): string {
  return stateDir({ kind: "user", userId });
}

export function userPiDir(userId: number): string {
  return join(userStateRoot(userId), "pi");
}

/** File-resource root (skills/agents/plugins) — not JSON state. */
export function userConfigDir(userId: number): string {
  return join(dataDir(), "user-config", `u${userId}`);
}

/** Legacy JSON root, retained read-only for one release. */
export function legacyUserConfigDir(userId: number): string {
  return join(dataDir(), "user-config", `u${userId}`);
}

export function isUserScopedConfig(userId: number | null | undefined): boolean {
  return typeof userId === "number" && Number.isInteger(userId) && userId > 0;
}

/** Raw pi settings overrides (only keys that differ from the global file). */
export function userSettingsDiffPath(userId: number): string {
  return join(userPiDir(userId), "settings.json");
}

export function legacyUserSettingsDiffPath(userId: number): string {
  return join(legacyUserConfigDir(userId), "settings.json");
}

export function userSkillsDir(userId: number): string {
  return join(userConfigDir(userId), "skills");
}

export function userAgentsDir(userId: number): string {
  return join(userConfigDir(userId), "agents");
}

export function userMcpConfigPath(userId: number): string {
  return join(userPiDir(userId), "mcp.json");
}

export function legacyUserMcpConfigPath(userId: number): string {
  return join(legacyUserConfigDir(userId), "mcp.json");
}

/** User-level plugin/extension package root (activation is per user). */
export function userPluginsDir(userId: number): string {
  return join(userConfigDir(userId), "plugins");
}

/** Push subscriptions for one login (VAPID keys stay deployment-global). */
export function userPushPath(userId: number): string {
  return join(userStateRoot(userId), "push.json");
}

export function legacyUserPushPath(userId: number): string {
  return join(legacyUserConfigDir(userId), "push.json");
}
