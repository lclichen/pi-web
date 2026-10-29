import { resolveSessionPath } from "./session-reader";
import { getRpcSessionOwner } from "./rpc-manager";
import { requireUserIdentity, type WebSession } from "./web-session";
import { spaceForRequest, type SessionSpace } from "./session-spaces";

/**
 * Per-request session access resolution (design doc §4): a session id is
 * usable only if it belongs to the caller — live registry ownership when the
 * session is running, otherwise a path fence against the caller's session
 * space. Cross-user access answers 404 (existence is not disclosed). Admins
 * may reach host-space sessions via ?space=host and other users' sessions
 * for support.
 */

export type SessionAccess =
  | { ok: true; session: WebSession; space: SessionSpace; path: string | null }
  | { ok: false; status: number; error: string };

export async function resolveSessionAccess(
  req: Request,
  sessionId: string,
  searchParams?: URLSearchParams,
): Promise<SessionAccess> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: 401, error: "登录已失效" };
  const { session } = identity;
  const { user } = session;

  // Auth off: implicit host admin sees everything (single-user status quo).
  if (user.id === 0) {
    const path = await resolveSessionPath(sessionId, { kind: "host" });
    return { ok: true, session, space: { kind: "host" }, path };
  }

  const owner = getRpcSessionOwner(sessionId);
  if (owner && owner.ownerId !== user.id && user.role !== "admin") {
    return { ok: false, status: 404, error: "会话不存在" };
  }

  const space = spaceForRequest(session, searchParams);
  let path = await resolveSessionPath(sessionId, space);
  if (!path && space.kind !== "host" && user.role === "admin") {
    // Admin fallback: the host space (CLI sessions).
    path = await resolveSessionPath(sessionId, { kind: "host" });
  }
  // resolveSessionPath already refuses paths outside the space fence; a miss
  // means "not yours" (or genuinely missing) — 404 either way for non-admins.
  if (!path && user.role !== "admin") {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  return { ok: true, session, space, path };
}

/**
 * Ownership fence for the LIVE-session fast path.
 *
 * The routes serve running sessions straight from the in-memory registry
 * (their files may not even be resolvable through the space fence yet), which
 * used to skip the ownership check entirely: knowing a live session id was
 * enough to read its transcript AND drive it — any logged-in user, not just
 * admins. This helper restores the fence: owner or admin only, 404 otherwise
 * (cross-user existence stays undisclosed). Ownerless wrappers (auth off,
 * legacy host sessions) remain reachable so single-user deployments are
 * unaffected.
 *
 * Admins keep access for support; the UI-side "owned by <user>, read-only"
 * treatment is a separate product decision (see docs/dev/session-access-and-
 * tool-bridge.md).
 */
export function checkLiveSessionAccess(
  req: Request,
  sessionId: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { ok: false, status: 401, error: "登录已失效" };
  const { user } = identity.session;
  if (user.id === 0) return { ok: true };
  const owner = getRpcSessionOwner(sessionId);
  if (owner && owner.ownerId !== 0 && owner.ownerId !== user.id && user.role !== "admin") {
    return { ok: false, status: 404, error: "会话不存在" };
  }
  return { ok: true };
}
