import { readdirSync } from "fs";
import { requireUserIdentity } from "./web-session";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions, listShardSessionCwds } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAllowedRootsCacheStore: Map<string, { roots: Set<string>; expiresAt: number }> | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

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
  // Admin host sessions live in their USER shards (agent/new routes host
  // sessions of logged-in admins there), which the global host listing above
  // never scans. Without their cwds here, every pi-web restart dropped those
  // directories from the fence (skills/files "Access denied") until a NEW
  // session in the directory re-allowed it in memory. Normal users still
  // resolve an empty root set — this only widens the admin/host view, which
  // resolveConfigCwdSync already treats as privileged.
  for (const cwd of await listShardSessionCwds()) {
    if (cwd) roots.add(normalizeSlashes(cwd));
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

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isPathWithinRoots(target, allowedRoots);
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
  if (!identity.ok) {
    // Auth is ON and the caller has no valid session. Fail CLOSED: an empty
    // set denies everything (the route layer also 401s first, but this fence
    // must never hand host roots to an unauthenticated request).
    return new Set<string>();
  }
  // No request object = trusted in-process caller (auth off / server-side).
  if (!identity.session || identity.session.user.id === 0) {
    return getAllowedFileRoots({ kind: "host" });
  }
  // Admins run Host-mode sessions against arbitrary server directories — their
  // requests must resolve the HOST space (whose roots derive from all host
  // sessions' cwds, persisted in the session files). Routing admins through
  // the user shard returned an EMPTY set: every server path then failed the
  // root check after any restart (Skills/Models/files "Access denied",
  // "No available models").
  if (identity.session.user.role === "admin") {
    return getAllowedFileRoots({ kind: "host" });
  }
  return getAllowedFileRoots({ kind: "user", userId: identity.session.user.id });
}
