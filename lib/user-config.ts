import { join } from "node:path";
import { dataDir } from "./mode-homes";

/**
 * Per-user configuration root. Web-only preferences live in
 * `data/user-settings/u<id>.json`; this directory holds the pi-native
 * settings diff plus user-scoped resources (skills/agents/MCP/plugins).
 *
 * user id 0 is the auth-off implicit host identity; callers keep using the
 * global agent directory for that case (see `isUserScopedConfig`).
 */
export function userConfigDir(userId: number): string {
  return join(dataDir(), "user-config", `u${userId}`);
}

export function isUserScopedConfig(userId: number | null | undefined): boolean {
  return typeof userId === "number" && Number.isInteger(userId) && userId > 0;
}

/** Raw pi settings overrides (only keys that differ from the global file). */
export function userSettingsDiffPath(userId: number): string {
  return join(userConfigDir(userId), "settings.json");
}

export function userSkillsDir(userId: number): string {
  return join(userConfigDir(userId), "skills");
}

export function userAgentsDir(userId: number): string {
  return join(userConfigDir(userId), "agents");
}

export function userMcpConfigPath(userId: number): string {
  return join(userConfigDir(userId), "mcp.json");
}

/** User-level plugin/extension package root (activation is per user). */
export function userPluginsDir(userId: number): string {
  return join(userConfigDir(userId), "plugins");
}

/** Push subscriptions for one login (VAPID keys stay deployment-global). */
export function userPushPath(userId: number): string {
  return join(userConfigDir(userId), "push.json");
}
