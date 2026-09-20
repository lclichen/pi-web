/**
 * Batch task authentication — X-Platform-API-Key (sk_...) validation.
 *
 * The batch API serves programmatic callers (test harnesses, CI) that hold a
 * platform API key minted by an admin. The key is validated against the
 * platform's /api/v1/auth/me endpoint, which resolves to the owning user's
 * identity (id, username, role). Admin keys are the expected audience; a
 * non-admin key gets 403.
 *
 * Existing web-session cookies also pass (browser debugging convenience).
 */
import { platformGet } from "@/lib/platform/client";
import { requireUserIdentity, type PlatformUser } from "@/lib/web-session";

export interface BatchIdentity {
  user: PlatformUser;
  apiKey: string;
}

const keyCache = new Map<string, { user: PlatformUser; at: number }>();
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

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
    const me = await platformGet<{ id: number; username: string; email: string | null; role: string; status: string }>(
      "/api/v1/auth/me",
      key,
    );
    if (!me || me.status !== "active") return null;
    const user: PlatformUser = {
      id: me.id,
      username: me.username,
      email: me.email,
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
 * session cookie. Admin role required (batch testing is an admin capability
 * per the product decision).
 */
export async function requireBatchIdentity(req: Request): Promise<
  { ok: true; identity: BatchIdentity } | { ok: false; status: number; error: string }
> {
  const key = platformKeyFrom(req);
  if (key) {
    const user = await resolvePlatformUser(key);
    if (!user) return { ok: false, status: 401, error: "Invalid or inactive platform API key" };
    if (user.role !== "admin") return { ok: false, status: 403, error: "Batch testing requires an admin API key" };
    return { ok: true, identity: { user, apiKey: key } };
  }
  // Fall back to web-session cookie (browser debugging).
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: 401, error: "Provide X-Platform-API-Key: sk_... or a valid session cookie" };
  if (identity.session.user.role !== "admin") return { ok: false, status: 403, error: "Batch testing requires admin role" };
  return { ok: true, identity: { user: identity.session.user, apiKey: identity.session.apiKey } };
}
