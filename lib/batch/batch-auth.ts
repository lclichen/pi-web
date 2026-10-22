/**
 * Batch task authentication — X-Platform-API-Key (sk_...) validation.
 *
 * The batch API serves programmatic callers (test harnesses, CI, embedded
 * workflows) that hold a platform API key minted by their owner. The key is
 * validated against the platform's /api/v1/auth/me endpoint, which resolves
 * to the owning user's identity (id, username, role).
 *
 * Open access + per-user concurrency limit (2026-10-22, was admin-only):
 * every valid key/cookie may submit tasks; each user ( admins exempt) is
 * capped at PI_WEB_BATCH_USER_MAX_CONCURRENT concurrent tasks (queued +
 * running + waiting_input). The cap counts QUEUED tasks too — otherwise a
 * user could stack an unbounded queue behind the global concurrency gate.
 *
 * Existing web-session cookies also pass (browser debugging convenience).
 */
import { platformGet } from "@/lib/platform/client";
import { requireUserIdentity, type PlatformUser } from "@/lib/web-session";
import { countUserActiveTasks } from "./task-store";

export interface BatchIdentity {
  user: PlatformUser;
  apiKey: string;
}

const keyCache = new Map<string, { user: PlatformUser; at: number }>();
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-user concurrent batch-task cap. Default 4; 0 disables the limit. */
export function batchUserMaxConcurrent(): number {
  const n = Number(process.env.PI_WEB_BATCH_USER_MAX_CONCURRENT ?? 4);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

/** Extract the platform API key from the X-Platform-API-Key header. */
function platformKeyFrom(req: Request): string | null {
  const direct = req.headers.get("x-platform-api-key");
  if (direct?.startsWith("sk_")) return direct.trim();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer sk_")) return bearer.slice(7).trim();
  return null;
}

/** Validate a platform API key → the owning platform user. */
async function resolvePlatformUser(key: string): Promise<PlatformUser | null> {
  const cached = keyCache.get(key);
  if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached.user;
  try {
    // The platform wraps /auth/me in { user: {...} }; accept both shapes so a
    // wrapper change degrades to a 401 (visible) rather than silent mismatch.
    const res = await platformGet<{
      user?: { id: number; username: string; email: string | null; role: string; status: string };
      id?: number; username?: string; email?: string | null; role?: string; status?: string;
    }>(
      "/api/v1/auth/me",
      key,
    );
    const me = res.user ?? res;
    if (!me || typeof me.id !== "number" || typeof me.username !== "string" || me.status !== "active") return null;
    const user: PlatformUser = {
      id: me.id,
      username: me.username,
      email: me.email ?? null,
      role: me.role === "admin" ? "admin" : "user",
      status: me.status,
    };
    keyCache.set(key, { user, at: Date.now() });
    return user;
  } catch {
    return null;
  }
}

/**
 * Batch API gate: accepts X-Platform-API-Key (sk_...) or an existing web
 * session cookie. Per-user concurrency limit enforced at task submission
 * (PI_WEB_BATCH_USER_MAX_CONCURRENT, admins exempt).
 */
export async function requireBatchIdentity(req: Request): Promise<
  { ok: true; identity: BatchIdentity } | { ok: false; status: number; error: string }
> {
  const key = platformKeyFrom(req);
  if (key) {
    const user = await resolvePlatformUser(key);
    if (!user) return { ok: false, status: 401, error: "Invalid or inactive platform API key" };
    return { ok: true, identity: { user, apiKey: key } };
  }
  // Fall back to web-session cookie (browser debugging).
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: 401, error: "Provide X-Platform-API-Key: sk_... or a valid session cookie" };
  return { ok: true, identity: { user: identity.session.user, apiKey: identity.session.apiKey } };
}

/**
 * Per-user concurrency check for task submission (429 with retry hint when
 * over the cap). Admins bypass — ops/eval runners stay unthrottled.
 */
export function checkBatchUserQuota(user: PlatformUser): { ok: true } | { ok: false; status: number; error: string; retryAfterMs: number } {
  const cap = batchUserMaxConcurrent();
  if (cap <= 0 || user.role === "admin") return { ok: true };
  const active = countUserActiveTasks(user.id);
  if (active >= cap) {
    return {
      ok: false,
      status: 429,
      error: `并发批量任务已达上限（${active}/${cap}，含排队中）。等待现有任务终态或取消后再提交；上限由部署 PI_WEB_BATCH_USER_MAX_CONCURRENT 配置。`,
      retryAfterMs: 30_000,
    };
  }
  return { ok: true };
}

/**
 * Task-ownership check for the [id] sub-routes (result/stream/cancel/resume/
 * artifacts): a non-admin may only touch their own tasks. Admin-only-era
 * tasks carry no ownerId (undefined) → admin-only visibility, matching the
 * list route's filtering.
 */
export function canAccessBatchTask(user: PlatformUser, ownerId: number | undefined): boolean {
  if (user.role === "admin") return true;
  return ownerId === user.id;
}
