/**
 * Session identity registry shared with pi-mcp-adapter.
 *
 * The adapter runs inside the same Node process but has no access to the
 * pi-web login user. It reads this registry by session id when building
 * outbound MCP HTTP headers and `_meta`. The registry is stored on
 * globalThis[Symbol.for(...)] so hot-reloaded module graphs and the
 * third-party adapter see the same instance.
 */
export const SESSION_IDENTITY_REGISTRY_KEY = "@agegr/pi-web/session-identity/v1";
export const SESSION_IDENTITY_PROTOCOL_VERSION = 1 as const;

export interface SessionIdentity {
  userId: number | string;
  userName?: string;
}

interface SessionIdentityRegistry {
  version: typeof SESSION_IDENTITY_PROTOCOL_VERSION;
  set(sessionId: string, identity: SessionIdentity): void;
  get(sessionId: string): SessionIdentity | undefined;
  delete(sessionId: string): void;
}

function createRegistry(): SessionIdentityRegistry {
  const identities = new Map<string, SessionIdentity>();
  return {
    version: SESSION_IDENTITY_PROTOCOL_VERSION,
    set(sessionId, identity) {
      if (!sessionId || !identity || identity.userId === undefined) return;
      identities.set(sessionId, { ...identity });
    },
    get(sessionId) {
      const identity = identities.get(sessionId);
      return identity ? { ...identity } : undefined;
    },
    delete(sessionId) {
      identities.delete(sessionId);
    },
  };
}

function isRegistry(value: unknown): value is SessionIdentityRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionIdentityRegistry>;
  return (
    candidate.version === SESSION_IDENTITY_PROTOCOL_VERSION &&
    typeof candidate.set === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.delete === "function"
  );
}

function registry(): SessionIdentityRegistry {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(SESSION_IDENTITY_REGISTRY_KEY);
  const existing = store[key];
  if (isRegistry(existing)) return existing;
  const created = createRegistry();
  store[key] = created;
  return created;
}

/** Register the owner identity for a session; returns an idempotent disposer. */
export function registerSessionIdentity(sessionId: string, identity: SessionIdentity): () => void {
  registry().set(sessionId, identity);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    registry().delete(sessionId);
  };
}

export function readSessionIdentity(sessionId: string): SessionIdentity | undefined {
  return registry().get(sessionId);
}

export function unregisterSessionIdentity(sessionId: string): void {
  registry().delete(sessionId);
}
