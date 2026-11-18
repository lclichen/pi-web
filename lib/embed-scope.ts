import type { EmbedScope } from "./embed-types.ts";

/** Minimal session shape needed to decide whether an access token may see it. */
export interface EmbedScopedSession {
  id: string;
  cwd?: string;
  projectId?: string;
  mode?: string;
  relation?: { kind?: string } | null;
}

/** Product access tokens are always project-scoped. */
export function sessionMatchesEmbedScope(scope: EmbedScope, session: EmbedScopedSession): boolean {
  if (session.relation?.kind === "subagent") return false;
  return Boolean(scope.projectId && session.projectId === scope.projectId);
}

export function filterSessionsForEmbedScope<T extends EmbedScopedSession>(
  sessions: readonly T[],
  scope: EmbedScope,
): T[] {
  return sessions.filter((session) => sessionMatchesEmbedScope(scope, session));
}
