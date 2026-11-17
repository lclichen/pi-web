import { samePath } from "./paths.ts";
import type { EmbedScope } from "./embed-types.ts";

/** Minimal session shape needed to decide whether a token may see it. */
export interface EmbedScopedSession {
  id: string;
  cwd?: string;
  projectId?: string;
  mode?: string;
  relation?: { kind?: string } | null;
}

/**
 * A token is scoped to either a project (all sessions with that projectId) or
 * one host directory (host-mode sessions whose cwd is that exact directory).
 * Subagent sessions are internal runtime detail and stay out of embed lists.
 */
export function sessionMatchesEmbedScope(scope: EmbedScope, session: EmbedScopedSession): boolean {
  if (session.relation?.kind === "subagent") return false;
  if (scope.kind === "project") {
    return Boolean(scope.projectId && session.projectId === scope.projectId);
  }
  if (session.mode && session.mode !== "host") return false;
  return Boolean(session.cwd && samePath(session.cwd, scope.cwd));
}

export function filterSessionsForEmbedScope<T extends EmbedScopedSession>(
  sessions: readonly T[],
  scope: EmbedScope,
): T[] {
  return sessions.filter((session) => sessionMatchesEmbedScope(scope, session));
}
