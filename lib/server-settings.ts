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
 *   PI_WEB_BUNDLE_UPLOAD_MAX_MB=2048  config-bundle (.zip/.apkg) upload cap
 *   PI_WEB_PUBLIC_URL=...     externally reachable base URL used when the
 *                             server mints absolute links (file shares); empty
 *                             = derive from the request Host
 */

/** Config-bundle upload default cap (MB). Also the env seed. */
export const BUNDLE_UPLOAD_DEFAULT_MB = 2048;
/** Above this size the browser asks for an explicit second confirmation. */
export const BUNDLE_UPLOAD_CONFIRM_MB = 200;
export const UPLOAD_MAX_MB_CEILING = 65536;
export const UPLOAD_MAX_MB_FLOOR = 1;

export interface ServerSettings {
  /** Whether the Lab Training teaching panel (and its toolbar toggle) is offered. */
  labTraining: boolean;
  /** Intranet SkillHub base URL (http(s)); empty/absent = skills.sh flow. */
  skillhubUrl?: string;
  /** Config-bundle upload cap in MB (absent = BUNDLE_UPLOAD_DEFAULT_MB). */
  bundleUploadMaxMb?: number;
  /**
   * Externally reachable base URL for absolute links (file shares). Seeded
   * from PI_WEB_PUBLIC_URL; absent = derive from the request Host.
   */
  publicBaseUrl?: string;
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
  const seedMb = normalizeUploadMaxMb(process.env.PI_WEB_BUNDLE_UPLOAD_MAX_MB, "PI_WEB_BUNDLE_UPLOAD_MAX_MB");
  let publicBaseUrl: string | undefined;
  try {
    publicBaseUrl = normalizePublicBaseUrl(process.env.PI_WEB_PUBLIC_URL);
  } catch (e) {
    console.warn(`[pi-web] 忽略非法 PI_WEB_PUBLIC_URL: ${e instanceof Error ? e.message : e}`);
  }
  return {
    labTraining: !off,
    ...(hub ? { skillhubUrl: hub } : {}),
    ...(seedMb !== undefined ? { bundleUploadMaxMb: seedMb } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
}

/**
 * Validate an upload cap in MB. Accepts numeric strings (env values) and
 * numbers; `undefined`/`""` clears the override. Throws on nonsense so a
 * misconfiguration surfaces instead of silently uploading with a wrong cap.
 */
export function normalizeUploadMaxMb(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${field} 必须是整数（MB）`);
  }
  if (value < UPLOAD_MAX_MB_FLOOR || value > UPLOAD_MAX_MB_CEILING) {
    throw new Error(`${field} 必须在 ${UPLOAD_MAX_MB_FLOOR}–${UPLOAD_MAX_MB_CEILING} MB 之间`);
  }
  return value;
}

/** Effective config-bundle cap (MB) — admin override or the default. */
export function getBundleUploadMaxMb(): number {
  return getServerSettings().bundleUploadMaxMb ?? BUNDLE_UPLOAD_DEFAULT_MB;
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

/**
 * 校验并归一化对外访问地址（share_file / POST /api/share 生成的链接前缀）。
 * 允许省略协议（默认 http://）、允许反向代理路径前缀（如 https://host/pi-web）；
 * 空串=清除；非法值抛错。
 */
export function normalizePublicBaseUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error("publicBaseUrl 必须是字符串");
  let trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) trimmed = `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`publicBaseUrl 地址无效: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`publicBaseUrl 必须是 http(s) 地址: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`publicBaseUrl 不能包含账号密码: ${raw}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`publicBaseUrl 不能包含查询串或锚点: ${raw}`);
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

/**
 * 绝对链接使用的对外地址：管理员覆盖（含 env 播种）> PI_WEB_PUBLIC_URL。
 * 都没有时返回 undefined — 由调用方按请求 Host 推断。
 */
export function getPublicBaseUrl(): string | undefined {
  const configured = getServerSettings().publicBaseUrl;
  if (configured) return configured;
  try {
    return normalizePublicBaseUrl(process.env.PI_WEB_PUBLIC_URL);
  } catch {
    return undefined;
  }
}

function parseStored(raw: unknown): Partial<ServerSettings> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const parsed = raw as {
    labTraining?: unknown;
    skillhubUrl?: unknown;
    bundleUploadMaxMb?: unknown;
    publicBaseUrl?: unknown;
  };
  const out: Partial<ServerSettings> = {};
  if (typeof parsed.labTraining === "boolean") out.labTraining = parsed.labTraining;
  const hub = normalizeSkillhubUrlSetting(parsed.skillhubUrl);
  if (hub !== undefined) out.skillhubUrl = hub;
  try {
    const mb = normalizeUploadMaxMb(parsed.bundleUploadMaxMb, "bundleUploadMaxMb");
    if (mb !== undefined) out.bundleUploadMaxMb = mb;
  } catch {
    // stored garbage — ignore the field, keep the rest
  }
  try {
    const base = normalizePublicBaseUrl(parsed.publicBaseUrl);
    if (base !== undefined) out.publicBaseUrl = base;
  } catch {
    // stored garbage — ignore the field, keep the rest
  }
  return out;
}

export function getServerSettings(): ServerSettings {
  if (!globalThis.__piServerSettingsStore || globalThis.__piServerSettingsStore.path !== settingsPath()) {
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

export function updateServerSettings(patch: {
  labTraining?: boolean;
  skillhubUrl?: string;
  bundleUploadMaxMb?: number | null;
  publicBaseUrl?: string;
}): ServerSettings {
  const next: ServerSettings = { ...getServerSettings() };
  if (typeof patch.labTraining === "boolean") next.labTraining = patch.labTraining;
  if (patch.skillhubUrl !== undefined) {
    // 显式传值：合法 → 覆盖；空串 → 清除（回到 skills.sh 流程）。undefined = 不动。
    const hub = normalizeSkillhubUrlSetting(patch.skillhubUrl);
    if (hub) next.skillhubUrl = hub;
    else delete next.skillhubUrl;
  }
  if (patch.bundleUploadMaxMb !== undefined) {
    // null = 清除覆盖（回到默认）。非法值由 normalizeUploadMaxMb 抛错。
    if (patch.bundleUploadMaxMb === null) delete next.bundleUploadMaxMb;
    else next.bundleUploadMaxMb = normalizeUploadMaxMb(patch.bundleUploadMaxMb, "bundleUploadMaxMb");
  }
  if (patch.publicBaseUrl !== undefined) {
    // 空串 = 清除（回到按请求 Host 自动推断）。非法值抛错。
    const base = normalizePublicBaseUrl(patch.publicBaseUrl);
    if (base) next.publicBaseUrl = base;
    else delete next.publicBaseUrl;
  }
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  globalThis.__piServerSettingsStore = { path: settingsPath(), data: next };
  return next;
}
