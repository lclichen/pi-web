import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { platformDelete } from "./platform/client";

/**
 * Web login sessions for PI_WEB_AUTH=on (multi-user mode).
 *
 * A browser holds an opaque cookie (`pi_web_sid`); the matching server-side
 * session keeps the platform user and a long-lived platform API key created
 * at login. The browser never sees any platform credential — every platform
 * call goes through pi-web BFF routes that use this API key.
 *
 * Sessions are in-memory (globalThis, hot-reload safe) AND persisted to
 * <data>/web-sessions.json (mode 0600) so a pi-web restart does not log
 * everyone out: an invalidated cookie then hits the API layer with 401 and
 * the UI redirects to /login instead of silently breaking.
 */

export interface PlatformUser {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  status: string;
}

export interface WebSession {
  sid: string;
  user: PlatformUser;
  /** Platform API key (sk_…) used for BFF calls. */
  apiKey: string;
  apiKeyId: number | string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * Set for the forced-password-change flow only: the login succeeded but
   * the platform requires a password change before anything else. This
   * session authorizes ONLY /api/webauth/change-password — it carries no
   * API key, so every other route rejects it.
   */
  changeTicket?: string;
}

export const WEB_SESSION_COOKIE = "pi_web_sid";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 10 * 60 * 1000;

declare global {
  var __piWebSessions: Map<string, WebSession> | undefined;
  // eslint-disable-next-line no-var
  var __piWebSessionsSweeper: ReturnType<typeof setInterval> | undefined;
}

function sessionFilePath(): string {
  return join(dataDir(), "web-sessions.json");
}

function loadPersisted(): Map<string, WebSession> {
  try {
    const parsed = JSON.parse(readFileSync(sessionFilePath(), "utf8")) as Record<string, WebSession>;
    const now = Date.now();
    const map = new Map<string, WebSession>();
    for (const [sid, session] of Object.entries(parsed)) {
      // Absolute TTL from createdAt, matching the cookie's fixed Max-Age —
      // a sliding server TTL would outlive the cookie and mint orphan keys.
      if (!sid || !session?.user || now - (session.createdAt ?? 0) > SESSION_TTL_MS) continue;
      map.set(sid, session);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Best-effort atomic write (0600, tmp+rename): sessions carry platform API keys. */
function persist(sessions: Map<string, WebSession>): void {
  try {
    const dir = dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(sessionFilePath(), JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch {
    // best-effort sidecar
  }
}

/**
 * Revoke the platform API key minted at login. Fire-and-forget: if the
 * platform is unreachable the session is still dropped locally; the key then
 * simply outlives the session (same trade-off as explicit logout).
 */
function revokeSessionKey(session: WebSession): void {
  if (!session.apiKey || !session.apiKeyId) return;
  void platformDelete(`/api/v1/auth/api-keys/${encodeURIComponent(String(session.apiKeyId))}`, session.apiKey)
    .catch(() => {});
}

function isExpired(session: WebSession, now: number): boolean {
  return now - (session.createdAt ?? 0) > SESSION_TTL_MS;
}

function store(): Map<string, WebSession> {
  if (!globalThis.__piWebSessions) {
    globalThis.__piWebSessions = loadPersisted();
  }
  if (!globalThis.__piWebSessionsSweeper) {
    globalThis.__piWebSessionsSweeper = setInterval(() => {
      const now = Date.now();
      const sessions = globalThis.__piWebSessions ?? new Map();
      let changed = false;
      for (const [sid, session] of sessions) {
        if (isExpired(session, now)) {
          sessions.delete(sid);
          // The platform key is long-lived; dropping only the local record
          // would leave a credential no one can ever revoke from the UI.
          revokeSessionKey(session);
          changed = true;
        }
      }
      if (changed) persist(sessions);
    }, SESSION_SWEEP_MS);
    globalThis.__piWebSessionsSweeper.unref?.();
  }
  return globalThis.__piWebSessions;
}

export function isWebAuthEnabled(): boolean {
  return process.env.PI_WEB_AUTH === "on";
}

export function createWebSession(user: PlatformUser, apiKey: string, apiKeyId: number | string, changeTicket?: string): WebSession {
  const session: WebSession = {
    sid: randomUUID(),
    user,
    apiKey,
    apiKeyId,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ...(changeTicket ? { changeTicket } : {}),
  };
  const sessions = store();
  sessions.set(session.sid, session);
  persist(sessions);
  return session;
}

export function getWebSession(request: Request): WebSession | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(`${WEB_SESSION_COOKIE}=`));
  if (!match) return null;
  const sid = match.slice(WEB_SESSION_COOKIE.length + 1).trim();
  if (!sid) return null;
  const session = store().get(sid);
  if (!session) return null;
  if (isExpired(session, Date.now())) {
    store().delete(sid);
    revokeSessionKey(session);
    persist(store());
    return null;
  }
  session.lastSeenAt = Date.now();
  return session;
}

export function dropWebSession(request: Request): void {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(`${WEB_SESSION_COOKIE}=`));
  if (!match) return;
  store().delete(match.slice(WEB_SESSION_COOKIE.length + 1).trim());
  persist(store());
}

export function sessionCookieHeader(sid: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  const parts = [
    `${WEB_SESSION_COOKIE}=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (process.env.PI_WEB_COOKIE_SECURE === "on") parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${WEB_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** The single-user identity used when PI_WEB_AUTH is off (status quo). */
export function hostIdentity(): PlatformUser {
  return { id: 0, username: "host", email: null, role: "admin", status: "active" };
}

/**
 * Resolve the requester identity for API routes. With auth off this is the
 * implicit host admin; with auth on it requires a valid web session. A
 * password-change ticket session is NOT a usable identity.
 */
export function requireUserIdentity(request: Request): { ok: true; session: WebSession } | { ok: false; status: number } {
  if (!isWebAuthEnabled()) {
    return { ok: true, session: { sid: "", user: hostIdentity(), apiKey: "", apiKeyId: "", createdAt: 0, lastSeenAt: 0 } };
  }
  const session = getWebSession(request);
  if (!session || session.changeTicket) return { ok: false, status: 401 };
  return { ok: true, session };
}
