import { isDeniedConfigPath } from "../project-config-bundle";

/**
 * Downlink projection policy: which `.pi` subtrees are copied Host → workspace,
 * plus the size/file caps used by the reconcile engine.
 *
 * - skills/agents are writable working copies; a local edit is kept unless the
 *   user discards it.
 * - attachments are a read-only cache of the Host primary; drift is overwritten
 *   (with a periodic full-content verification because stat is only a fast path).
 * - runtime/ is a one-way copy of entry scripts + data that must execute in the
 *   remote workspace.
 * - .apkg_runtime is limited to the Python loader, encrypted bundle and optional
 *   platform-matched decryptor; arbitrary files there are never projected.
 */

export const PROJECTION_SKILLS_PREFIX = ".pi/skills/";
export const PROJECTION_AGENTS_PREFIX = ".pi/agents/";
export const PROJECTION_ATTACHMENTS_PREFIX = ".pi/attachments/";
/** Runnable entry assets + data for remote workspaces. */
export const PROJECTION_RUNTIME_PREFIX = ".pi/runtime/";

/** apkg-publisher Python runtime (loader + encrypted bundle + optional
 *  platform-matched decryptor binary). Only these exact files are projected;
 *  arbitrary .apkg_runtime content is still rejected. */
const APKG_RUNTIME_FILES = new Set([
  ".pi/.apkg_runtime/apkg.py",
  ".pi/.apkg_runtime/python.bundle",
  ".pi/.apkg_runtime/apkg-publisher",
  ".pi/.apkg_runtime/apkg-publisher.exe",
  ".apkg_runtime/apkg.py",
  ".apkg_runtime/python.bundle",
  ".apkg_runtime/apkg-publisher",
  ".apkg_runtime/apkg-publisher.exe",
]);

/** Roots passed to a provider's batched manifest (no trailing slash). */
const BASE_PROJECTION_ROOTS = [".pi/skills", ".pi/agents", ".pi/attachments"] as const;
const RUNTIME_PROJECTION_ROOTS = [".pi/runtime", ".pi/.apkg_runtime", ".apkg_runtime"] as const;

export interface ProjectionPolicyOptions {
  /** `.pi/bundle.json` workspaceProjection.runtime (default true). When false,
   *  runtime scripts and the encrypted Python runtime stay Host-only. */
  projectRuntime?: boolean;
}

export function projectionRoots(projectRuntime = true): string[] {
  return projectRuntime
    ? [...BASE_PROJECTION_ROOTS, ...RUNTIME_PROJECTION_ROOTS]
    : [...BASE_PROJECTION_ROOTS];
}

/** Default roots (runtime projected); callers with a package declaration use
 *  projectionRoots(projectRuntime). */
export const PROJECTION_ROOTS = projectionRoots(true);

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
export function isProjectionDir(rel: string, options: ProjectionPolicyOptions = {}): boolean {
  const normalized = normalizeProjectionRel(rel);
  if (isProjectionExcludedPath(normalized)) return false;
  if (normalized === ".pi") return true;
  if (options.projectRuntime === false) {
    return [".pi/skills", ".pi/agents", ".pi/attachments"].some(
      (dir) => normalized === dir || normalized.startsWith(`${dir}/`),
    );
  }
  if (normalized === ".apkg_runtime" || normalized.startsWith(".apkg_runtime/")) return true;
  return [
    ".pi/skills",
    ".pi/agents",
    ".pi/attachments",
    ".pi/runtime",
    ".pi/.apkg_runtime",
  ].some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

export function isProjectedPath(rel: string, options: ProjectionPolicyOptions = {}): boolean {
  const normalized = normalizeProjectionRel(rel);
  if (isProjectionExcludedPath(normalized)) return false;
  const projectRuntime = options.projectRuntime !== false;
  if (projectRuntime && APKG_RUNTIME_FILES.has(normalized)) return true;
  if (!PROJECTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    if (!projectRuntime || !normalized.startsWith(PROJECTION_RUNTIME_PREFIX)) return false;
  }
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
  if (APKG_RUNTIME_FILES.has(normalized)) return 0;
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
