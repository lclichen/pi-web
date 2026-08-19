import { readdirSync } from "fs";
import { requireUserIdentity } from "./web-session";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAllowedRootsCacheStore: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export async function getAllowedFileRoots(space: { kind: "host" } | { kind: "user"; userId: number } = { kind: "host" }): Promise<Set<string>> {
  const now = Date.now();
  // 缓存按空间分键：host 空间沿用旧字段（单用户/CLI 语义不变）。
  const store = () => globalThis.__piAllowedRootsCacheStore ?? (globalThis.__piAllowedRootsCacheStore = new Map());
  const cacheKey = space.kind === "host" ? "host" : `u${space.userId}`;
  const cached = store().get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.roots;

  if (space.kind !== "host") {
    // 普通登录用户不经过服务器本地文件系统（沙箱/本机模式走 remotefs；
    // Host 模式是管理员专用）。空集合=全部拒绝。
    const empty = new Set<string>();
    store().set(cacheKey, { roots: empty, expiresAt: now + ALLOWED_ROOTS_TTL_MS });
    return empty;
  }
  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/pi-cwd-* directories created by the default-cwd endpoint
  // (host space only — user shards never expose server-local dirs).
  if (space.kind !== "host") {
    return roots;
  }
  try {
    for (const name of readdirSync(homedir())) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  store().set(cacheKey, { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS });
  return roots;
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}


/**
 * Allowed roots for an incoming request: the host space for admins /
 * auth-off, the caller's (empty) user shard otherwise.
 */
export async function getAllowedFileRootsForRequest(req: Request | undefined | null): Promise<Set<string>> {
  const identity = req ? requireUserIdentity(req) : { ok: true as const, session: null };
  if (!identity.ok || !identity.session || identity.session.user.id === 0) {
    return getAllowedFileRoots({ kind: "host" });
  }
  return getAllowedFileRoots({ kind: "user", userId: identity.session.user.id });
}
