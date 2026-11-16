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
 *   PI_WEB_DISABLE_NPM_PACKAGES=1  disable SDK npm auto-install/update checks
 *                             (equivalent to PI_OFFLINE=1; admin can toggle it)
 *   PI_WEB_NPM_REGISTRY=...   npm registry mirror for installs and terminals
 *   PI_WEB_PIP_INDEX_URL=...  PyPI simple index for pip in terminals
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
  /**
   * Disable npm package auto-install / update checks process-wide (sets
   * PI_OFFLINE=1). Intended for machines that cannot reach an npm registry:
   * the SDK otherwise tries to install missing configured packages while
   * loading resources, which has no timeout and can hang /api/models.
   */
  disableNpmPackages: boolean;
  /** Optional npm registry mirror (https://registry.npmmirror.com). */
  npmRegistry?: string;
  /** Optional PyPI simple index URL (https://pypi.tuna.tsinghua.edu.cn/simple). */
  pipIndexUrl?: string;
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
  const truthy = (value: string | undefined): boolean =>
    /^(1|true|yes|on)$/i.test((value ?? "").trim());
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
  let npmRegistry: string | undefined;
  try {
    npmRegistry = normalizePackageMirrorUrl(process.env.PI_WEB_NPM_REGISTRY, "PI_WEB_NPM_REGISTRY");
  } catch (e) {
    console.warn(`[pi-web] 忽略非法 PI_WEB_NPM_REGISTRY: ${e instanceof Error ? e.message : e}`);
  }
  let pipIndexUrl: string | undefined;
  try {
    pipIndexUrl = normalizePackageMirrorUrl(process.env.PI_WEB_PIP_INDEX_URL, "PI_WEB_PIP_INDEX_URL");
  } catch (e) {
    console.warn(`[pi-web] 忽略非法 PI_WEB_PIP_INDEX_URL: ${e instanceof Error ? e.message : e}`);
  }
  return {
    labTraining: !off,
    disableNpmPackages: truthy(process.env.PI_WEB_DISABLE_NPM_PACKAGES) || truthy(process.env.PI_OFFLINE),
    ...(npmRegistry ? { npmRegistry } : {}),
    ...(pipIndexUrl ? { pipIndexUrl } : {}),
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
 * Validate an npm registry / PyPI index URL. Empty/null clears the override;
 * credentials and query/hash are rejected (mirror URLs are meant to be shared
 * in env/terminal output). Returns undefined when cleared.
 */
export function normalizePackageMirrorUrl(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`${field} 必须是字符串`);
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${field} 地址无效: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} 必须是 http(s) 地址: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} 不能包含账号密码: ${raw}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${field} 不能包含查询串或锚点: ${raw}`);
  }
  return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
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
    disableNpmPackages?: unknown;
    npmRegistry?: unknown;
    pipIndexUrl?: unknown;
    skillhubUrl?: unknown;
    bundleUploadMaxMb?: unknown;
    publicBaseUrl?: unknown;
  };
  const out: Partial<ServerSettings> = {};
  if (typeof parsed.labTraining === "boolean") out.labTraining = parsed.labTraining;
  if (typeof parsed.disableNpmPackages === "boolean") out.disableNpmPackages = parsed.disableNpmPackages;
  try {
    const registry = normalizePackageMirrorUrl(parsed.npmRegistry, "npmRegistry");
    if (registry) out.npmRegistry = registry;
  } catch {
    // stored garbage — ignore the field, keep the rest
  }
  try {
    const pip = normalizePackageMirrorUrl(parsed.pipIndexUrl, "pipIndexUrl");
    if (pip) out.pipIndexUrl = pip;
  } catch {
    // stored garbage — ignore the field, keep the rest
  }
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

/** True when pi-web itself put PI_OFFLINE into the process env (not the operator). */
let npmOfflineAppliedBySettings = false;

/**
 * Project the admin setting onto PI_OFFLINE, the only switch the pi SDK exposes
 * for "do not install missing packages / do not check for updates". Setting it
 * before any package load prevents the SDK's unbounded `npm install` from
 * blocking /api/models on machines without registry access.
 */
export function applyPackageNetworkMode(): void {
  const disabled = getServerSettings().disableNpmPackages === true;
  if (disabled) {
    if (process.env.PI_OFFLINE !== "1") {
      process.env.PI_OFFLINE = "1";
      npmOfflineAppliedBySettings = true;
    }
    return;
  }
  // Never clear an operator-provided PI_OFFLINE; only undo our own injection.
  if (npmOfflineAppliedBySettings) {
    delete process.env.PI_OFFLINE;
    npmOfflineAppliedBySettings = false;
  }
}

/** Effective offline-package state (admin setting or operator PI_OFFLINE). */
export function isNpmPackagesDisabled(): boolean {
  return getServerSettings().disableNpmPackages === true || process.env.PI_OFFLINE === "1";
}

/** Original values captured before pi-web projects mirror settings into env. */
const originalPackageEnv = new Map<string, string | undefined>();

function setPackageEnv(name: string, value: string | undefined): void {
  if (!originalPackageEnv.has(name)) originalPackageEnv.set(name, process.env[name]);
  if (value !== undefined) {
    process.env[name] = value;
    return;
  }
  const original = originalPackageEnv.get(name);
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/**
 * Mirror settings into the env vars npm/pip actually read. This covers SDK
 * package installs (it spawns npm with process.env) and host terminals
 * (local-terminal copies process.env); remote terminals get an export prefix
 * in lib/remote-terminal.ts.
 */
export function applyPackageRegistryEnv(): void {
  const settings = getServerSettings();
  setPackageEnv("NPM_CONFIG_REGISTRY", settings.npmRegistry);
  // npm reads either case depending on platform; keep both in sync.
  setPackageEnv("npm_config_registry", settings.npmRegistry);
  setPackageEnv("PIP_INDEX_URL", settings.pipIndexUrl);
}

export function updateServerSettings(patch: {
  labTraining?: boolean;
  disableNpmPackages?: boolean;
  npmRegistry?: string;
  pipIndexUrl?: string;
  skillhubUrl?: string;
  bundleUploadMaxMb?: number | null;
  publicBaseUrl?: string;
}): ServerSettings {
  const next: ServerSettings = { ...getServerSettings() };
  if (typeof patch.labTraining === "boolean") next.labTraining = patch.labTraining;
  if (typeof patch.disableNpmPackages === "boolean") next.disableNpmPackages = patch.disableNpmPackages;
  if (patch.npmRegistry !== undefined) {
    const registry = normalizePackageMirrorUrl(patch.npmRegistry, "npmRegistry");
    if (registry) next.npmRegistry = registry;
    else delete next.npmRegistry;
  }
  if (patch.pipIndexUrl !== undefined) {
    const pip = normalizePackageMirrorUrl(patch.pipIndexUrl, "pipIndexUrl");
    if (pip) next.pipIndexUrl = pip;
    else delete next.pipIndexUrl;
  }
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
  applyPackageNetworkMode();
  applyPackageRegistryEnv();
  return next;
}
