import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./mode-homes";

/**
 * Deployment-wide server settings (data/server-settings.json).
 *
 * Values are seeded from environment variables on first read so the operator
 * picks a default at deploy time, then admins can flip them at runtime without
 * a restart (effective for every client on next page load).
 *
 *   PI_WEB_LAB_TRAINING=off   hide the Lab Training side panel for all users
 */

export interface ServerSettings {
  /** Whether the Lab Training teaching panel (and its toolbar toggle) is offered. */
  labTraining: boolean;
}

declare global {
  var __piServerSettingsStore: { path: string; data: ServerSettings } | undefined;
}

function settingsPath(): string {
  return join(dataDir(), "server-settings.json");
}

function envDefaults(): ServerSettings {
  const raw = (process.env.PI_WEB_LAB_TRAINING ?? "").trim().toLowerCase();
  const off = raw === "off" || raw === "0" || raw === "false" || raw === "no";
  return { labTraining: !off };
}

export function getServerSettings(): ServerSettings {
  if (
    !globalThis.__piServerSettingsStore ||
    globalThis.__piServerSettingsStore.path !== settingsPath()
  ) {
    let data: ServerSettings | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as { labTraining?: unknown }).labTraining === "boolean"
      ) {
        data = { labTraining: (parsed as { labTraining: boolean }).labTraining };
      }
    } catch {
      // fresh store — fall through to env defaults
    }
    globalThis.__piServerSettingsStore = { path: settingsPath(), data: data ?? envDefaults() };
  }
  return globalThis.__piServerSettingsStore.data;
}

export function updateServerSettings(patch: { labTraining?: boolean }): ServerSettings {
  const next: ServerSettings = { ...getServerSettings(), ...patch };
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  globalThis.__piServerSettingsStore = { path: settingsPath(), data: next };
  return next;
}
