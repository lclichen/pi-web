/**
 * Personal activity counters for the sidebar/favicon. The running poll and the
 * session catalogue can contain other users' sessions for an admin (support
 * view); those must never become this user's unread markers or tab badge.
 */

export interface BadgeSession {
  id: string;
  ownerId?: number;
  relation?: { kind?: string };
}

/** Personal sessions only: another user's support rows never count. Auth-off
 * (user 0) owns the host/legacy rows. */
export function isOwnSession(session: BadgeSession, userId: number): boolean {
  if (userId > 0) return session.ownerId === userId;
  return session.ownerId === undefined || session.ownerId === 0;
}

/** Unread/running counts for the tab badge: own sessions, subagents excluded. */
export function badgeCounts(
  sessions: readonly BadgeSession[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
  userId: number,
): { unread: number; running: number } {
  let unread = 0;
  let running = 0;
  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    if (!isOwnSession(session, userId)) continue;
    if (unreadSessionIds.has(session.id)) unread += 1;
    if (runningSessionIds.has(session.id)) running += 1;
  }
  return { unread, running };
}

/** Unread markers are per login; auth-off keeps the legacy single-user key. */
export function unreadStorageKey(userId?: number | null): string {
  return userId && userId > 0 ? `pi-web:unread-session-ids:u${userId}` : "pi-web:unread-session-ids";
}
