import { isDeniedConfigPath } from "../project-config-bundle";

/**
 * Downlink projection policy: which `.pi` subtrees are copied Host → workspace,
 * plus the size/file caps used by the reconcile engine.
 *
 * - skills/agents are writable working copies; a local edit is kept unless the
 *   user discards it.
 * - attachments are a read-only cache of the Host primary; drift is overwritten
 *   (with a periodic full-content verification because stat is only a fast path).
 */

export const PROJECTION_SKILLS_PREFIX = ".pi/skills/";
export const PROJECTION_AGENTS_PREFIX = ".pi/agents/";
export const PROJECTION_ATTACHMENTS_PREFIX = ".pi/attachments/";

export const PROJECTION_MAX_FILES = 2_000;
export const PROJECTION_MAX_BYTES = 64 * 1024 * 1024;
export const PROJECTION_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Full attachment hash sweep interval (stat is the fast path in between). */
export const ATTACHMENT_VERIFY_INTERVAL_MS = 10 * 60 * 1000;

const PROJECTION_PREFIXES = [
  PROJECTION_SKILLS_PREFIX,
  PROJECTION_AGENTS_PREFIX,
  PROJECTION_ATTACHMENTS_PREFIX,
] as const;

export function normalizeProjectionRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isAttachmentRel(rel: string): boolean {
  return normalizeProjectionRel(rel).startsWith(PROJECTION_ATTACHMENTS_PREFIX);
}

/**
 * Repo internals and package-manager caches inside a skill are not runtime
 * content: projecting `.git` copies history/objects and `node_modules/.cache`
 * burns the 64MB budget on rebuild artifacts.
 */
function isProjectionExcludedPath(rel: string): boolean {
  const normalized = normalizeProjectionRel(rel);
  if (normalized.split("/").includes(".git")) return true;
  return normalized.includes("/node_modules/.cache");
}

/** Directories the Host walk descends into (`.pi` itself plus the subtrees). */
export function isProjectionDir(rel: string): boolean {
  const normalized = normalizeProjectionRel(rel);
  if (isProjectionExcludedPath(normalized)) return false;
  if (normalized === ".pi") return true;
  return [
    ".pi/skills",
    ".pi/agents",
    ".pi/attachments",
  ].some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

export function isProjectedPath(rel: string): boolean {
  const normalized = normalizeProjectionRel(rel);
  if (isProjectionExcludedPath(normalized)) return false;
  if (!PROJECTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (normalized === ".pi/.sync-backups" || normalized.startsWith(".pi/.sync-backups/")) return false;
  if (isAttachmentRel(normalized)) {
    const name = normalized.slice(PROJECTION_ATTACHMENTS_PREFIX.length);
    // Hidden runtime files (upload temps) are not attachments.
    return Boolean(name) && !name.split("/").some((part) => part.startsWith("."));
  }
  return !isDeniedConfigPath(normalized);
}

/** Sort priority for truncation: node_modules last, scripts/docs first. */
export function projectionPriority(rel: string): number {
  const normalized = normalizeProjectionRel(rel);
  if (normalized.includes("/node_modules/")) return 2;
  if (normalized.endsWith("/SKILL.md") || normalized.endsWith("/AGENTS.md")) return 0;
  if (normalized.includes("/scripts/") || normalized.includes("/references/") || normalized.includes("/assets/")) {
    return 1;
  }
  return 1;
}

/**
 * Root `/` or a drive root would project `.pi` into the filesystem root; refuse
 * it instead of writing there.
 */
export function projectionRootError(root: string): string | null {
  const normalized = root.replace(/\\/g, "/").trim();
  if (!normalized || normalized === "/") return "工作区根目录无效，拒绝投影";
  if (/^[A-Za-z]:\/?$/.test(normalized)) return "工作区根目录是盘符根，拒绝投影";
  return null;
}
