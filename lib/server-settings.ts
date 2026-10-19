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
 *   PI_WEB_LAB_TRAINING=off   hide the Lab Training teaching panel for all users
 *   PI_WEB_SKILLHUB_URL=...   intranet SkillHub base URL (skill search/install
 *                             source; empty = the default skills.sh flow)
 */

export interface ServerSettings {
  /** Whether the Lab Training teaching panel (and its toolbar toggle) is offered. */
  labTraining: boolean;
  /** Intranet SkillHub base URL (http(s)); empty/absent = skills.sh flow. */
  skillhubUrl?: string;
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
  // 非法 env 不致命：忽略（回落 skills.sh 流程），错误在运行时设置时显式暴露。
  let hub: string | undefined;
  try {
    hub = normalizeSkillhubUrlSetting(process.env.PI_WEB_SKILLHUB_URL);
  } catch (e) {
    console.warn(`[pi-web] 忽略非法 PI_WEB_SKILLHUB_URL: ${e instanceof Error ? e.message : e}`);
  }
  return { labTraining: !off, ...(hub ? { skillhubUrl: hub } : {}) };
}

/** 校验并归一化 skillhubUrl；空串=清除；非法值抛错（配置错误要显式暴露）。 */
export function normalizeSkillhubUrlSetting(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("skillhubUrl 必须是字符串");
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`skillhubUrl 地址无效: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`skillhubUrl 必须是 http(s) 地址: ${raw}`);
  }
  return trimmed;
}

function parseStored(raw: unknown): Partial<ServerSettings> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const parsed = raw as { labTraining?: unknown; skillhubUrl?: unknown };
  const out: Partial<ServerSettings> = {};
  if (typeof parsed.labTraining === "boolean") out.labTraining = parsed.labTraining;
  const hub = normalizeSkillhubUrlSetting(parsed.skillhubUrl);
  if (hub !== undefined) out.skillhubUrl = hub;
  return out;
}

export function getServerSettings(): ServerSettings {
  if (
    !globalThis.__piServerSettingsStore ||
    globalThis.__piServerSettingsStore.path !== settingsPath()
  ) {
    let stored: Partial<ServerSettings> | undefined;
    try {
      stored = parseStored(JSON.parse(readFileSync(settingsPath(), "utf8")));
    } catch {
      // fresh store — fall through to env defaults
    }
    globalThis.__piServerSettingsStore = { path: settingsPath(), data: { ...envDefaults(), ...stored } };
  }
  return globalThis.__piServerSettingsStore.data;
}

export function updateServerSettings(patch: { labTraining?: boolean; skillhubUrl?: string }): ServerSettings {
  const next: ServerSettings = { ...getServerSettings() };
  if (typeof patch.labTraining === "boolean") next.labTraining = patch.labTraining;
  if (patch.skillhubUrl !== undefined) {
    // 显式传值：合法 → 覆盖；空串 → 清除（回到 skills.sh 流程）。undefined = 不动。
    const hub = normalizeSkillhubUrlSetting(patch.skillhubUrl);
    if (hub) next.skillhubUrl = hub;
    else delete next.skillhubUrl;
  }
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  globalThis.__piServerSettingsStore = { path: settingsPath(), data: next };
  return next;
}
