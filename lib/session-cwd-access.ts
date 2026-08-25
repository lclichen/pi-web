import { listAllSessions } from "./session-reader";
import { requireUserIdentity } from "./web-session";
import { spaceForRequest } from "./session-spaces";
import type { SessionSpace } from "./session-spaces";

/**
 * Session-cwd allowances for file/model access checks.
 *
 * Allowed file roots are populated transiently when a session is CREATED
 * (in-memory) — after a pi-web restart every existing session's cwd fails the
 * root check, and the model picker / file explorer die with "Access denied".
 * A directory the caller already has a session in is correct-by-construction:
 * the session was authorized when it started.
 */

/** The caller's sessions' working directories (host space included for admins). */
async function callerSessionCwds(req: Request): Promise<string[]> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return [];
  const { user } = identity.session;
  const spaces: SessionSpace[] =
    user.id === 0 || user.role === "admin"
      ? [{ kind: "host" }, spaceForRequest(identity.session)]
      : [spaceForRequest(identity.session)];
  const cwds: string[] = [];
  for (const space of spaces) {
    const sessions = await listAllSessions(space).catch(() => []);
    for (const s of sessions) if (s.cwd) cwds.push(s.cwd.replace(/\/+$/, ""));
  }
  return [...new Set(cwds)];
}

/** May the caller use `cwd` (e.g. list models / browse files rooted there)? */
export async function isCallerSessionCwdAllowed(
  req: Request,
  cwd: string,
): Promise<boolean> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return false;
  const { user } = identity.session;

  // Admins (and the implicit host identity of auth-off mode) may open any
  // server directory — the directory picker is admin-only.
  if (user.id === 0 || user.role === "admin") return true;

  const target = cwd.replace(/\/+$/, "");
  const cwds = await callerSessionCwds(req);
  return cwds.includes(target);
}

/** The request's allowed roots PLUS the caller's sessions' cwds — the
 *  path-fence semantics are preserved (targets must still be inside a root),
 *  but existing sessions keep working across pi-web restarts. */
export async function allowedRootsWithSessionCwds(
  req: Request,
  roots: Set<string>,
): Promise<Set<string>> {
  const cwds = await callerSessionCwds(req);
  if (cwds.length === 0) return roots;
  const merged = new Set(roots);
  for (const c of cwds) merged.add(c);
  return merged;
}
