/**
 * 应用版本与更新（自有版本体系 amedac.ai-agent-framework）。
 *
 * - 版本事实源：仓库/包根的 version.json（打包时随包分发，另附 pkg-kind 标记
 *   tarball|appimage|electron）。
 * - 更新源：用户指定的 catalog.json（schema_version 1）
 *   ——AMEDAC_UPDATE_CATALOG_URL 指向 http(s) URL 或本地文件路径。
 * - 未配置更新源时回落上游 npm 检查（开发场景旧行为）。
 */
import { isAbsolute } from "node:path";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseStableVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

export function getPiWebReleaseUrl(version: string): string | null {
  if (!parseStableVersion(version)) return null;
  return `https://github.com/agegr/pi-web/releases/tag/v${version}`;
}

/* ------------------------------ semver（含 prerelease） ------------------------------ */

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** null = 正式版；非空 = 预发布标识（点分段）。 */
  prerelease: string[] | null;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemver(version: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![major, minor, patch].every((p) => Number.isSafeInteger(p) && p >= 0)) return null;
  const prerelease = match[4] !== undefined && match[4] !== ""
    ? match[4].split(".").filter((part) => part.length > 0)
    : null;
  return { major, minor, patch, prerelease };
}

/** 预发布段比较：数字段按数值、字母段按字典序、数字段 < 字母段；段多者大（同为预发布时）。 */
function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // a 是 b 的前缀 → a 更小
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** 语义化版本比较：candidate > current 才返回 true（同一版本不算更新）。 */
export function isNewerSemver(candidate: string, current: string): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (!c || !cur) return false;
  const core = [c.major, c.minor, c.patch];
  const curCore = [cur.major, cur.minor, cur.patch];
  for (let i = 0; i < 3; i += 1) {
    if (core[i] !== curCore[i]) return core[i] > curCore[i];
  }
  if (c.prerelease === null && cur.prerelease === null) return false;
  if (c.prerelease === null) return true; // 正式版 > 预发布
  if (cur.prerelease === null) return false;
  return comparePrerelease(c.prerelease, cur.prerelease) > 0;
}

/* ------------------------------ catalog.json ------------------------------ */

export interface CatalogFramework {
  file_name: string;
  relative_path: string;
  checksum_sha256: string;
  size_bytes: number;
}

export interface CatalogVersion {
  version: string;
  channel: string;
  released_at?: string;
  release_dir?: string;
  frameworks: Partial<Record<"tarball" | "appimage" | "electron", CatalogFramework>>;
}

export interface UpdateCatalog {
  project?: string;
  defaultVersion: string;
  latestVersions: Record<string, string>;
  versions: CatalogVersion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFramework(value: unknown, errors: string[], label: string): CatalogFramework | null {
  if (!isRecord(value)) return null;
  const file_name = typeof value.file_name === "string" ? value.file_name : "";
  const relative_path = typeof value.relative_path === "string" ? value.relative_path : "";
  const checksum_sha256 = typeof value.checksum_sha256 === "string" ? value.checksum_sha256 : "";
  const size_bytes = typeof value.size_bytes === "number" ? value.size_bytes : 0;
  if (!file_name || !relative_path || !/^[0-9a-f]{64}$/i.test(checksum_sha256)) {
    errors.push(`${label}: file_name/relative_path/checksum_sha256 缺失或格式非法`);
    return null;
  }
  // relative_path 必须是 catalog 同目录内的相对路径——拒绝绝对路径与 .. 逃逸。
  const segments = relative_path.split(/[\\/]+/);
  if (isAbsolute(relative_path) || segments.includes("..")) {
    errors.push(`${label}: relative_path 必须是相对路径且不含 ..`);
    return null;
  }
  return { file_name, relative_path, checksum_sha256: checksum_sha256.toLowerCase(), size_bytes };
}

export function parseUpdateCatalog(value: unknown): UpdateCatalog {
  if (!isRecord(value)) throw new Error("catalog 不是 JSON 对象");
  if (value.schema_version !== 1) throw new Error(`不支持的 catalog schema_version: ${String(value.schema_version)}`);
  const defaultVersion = typeof value.default_version === "string" ? value.default_version : "";
  if (!defaultVersion) throw new Error("catalog 缺少 default_version");

  const latestVersions: Record<string, string> = {};
  if (isRecord(value.latest_versions)) {
    for (const [channel, v] of Object.entries(value.latest_versions)) {
      if (typeof v === "string" && v) latestVersions[channel] = v;
    }
  }

  const rawVersions = Array.isArray(value.versions) ? value.versions : [];
  const errors: string[] = [];
  const versions: CatalogVersion[] = [];
  for (const raw of rawVersions) {
    if (!isRecord(raw)) continue;
    const version = typeof raw.version === "string" ? raw.version : "";
    const channel = typeof raw.channel === "string" ? raw.channel : "";
    if (!version || !channel) {
      errors.push(`版本条目缺少 version/channel: ${version || "(空)"}`);
      continue;
    }
    const frameworks: CatalogVersion["frameworks"] = {};
    if (isRecord(raw.frameworks)) {
      for (const kind of ["tarball", "appimage", "electron"] as const) {
        const fw = parseFramework(raw.frameworks[kind], errors, `${version}.frameworks.${kind}`);
        if (fw) frameworks[kind] = fw;
      }
    }
    versions.push({
      version,
      channel,
      released_at: typeof raw.released_at === "string" ? raw.released_at : undefined,
      release_dir: typeof raw.release_dir === "string" ? raw.release_dir : undefined,
      frameworks,
    });
  }
  if (versions.length === 0) throw new Error(`catalog 没有可用版本条目（${errors.slice(0, 3).join("；")}）`);
  return {
    project: typeof value.project === "string" ? value.project : undefined,
    defaultVersion,
    latestVersions,
    versions,
  };
}

/** 按 channel 选目标版本（latest_versions[channel] → default_version → 该 channel 最新）。 */
export function selectCatalogTarget(
  catalog: UpdateCatalog,
  channel: string,
): CatalogVersion | null {
  const wanted = catalog.latestVersions[channel] ?? catalog.defaultVersion;
  const byVersion = catalog.versions.find((v) => v.version === wanted && v.channel === channel);
  if (byVersion) return byVersion;
  return catalog.versions.find((v) => v.version === wanted) ?? null;
}
