import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  EmbedAccessRecord,
  EmbedMode,
  EmbedScope,
  EmbedUser,
} from "./embed-types.ts";

/**
 * Short-lived embed access tokens.
 *
 * These are exchanged from a user's long-lived platform API key and live only
 * in memory. A pi-web restart invalidates them; the product or the auth gate
 * simply exchanges the API key again. Project ids remain the stable reference.
 */

const TOKEN_PREFIX = "emba_";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 7 * DAY_MS;
const MAX_TOKENS_PER_USER = 50;

export function embedAccessTtlMs(): number {
  const raw = Number(process.env.PI_WEB_EMBED_ACCESS_TTL_MINUTES ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, raw * 60_000));
}

declare global {
   
  var __piEmbedAccess: Map<string, EmbedAccessRecord> | undefined;
}

function store(): Map<string, EmbedAccessRecord> {
  if (!globalThis.__piEmbedAccess) globalThis.__piEmbedAccess = new Map();
  return globalThis.__piEmbedAccess;
}

export function hashEmbedAccessToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function prune(now = Date.now()): void {
  const tokens = store();
  for (const [hash, record] of tokens) {
    if (record.expiresAt <= now) tokens.delete(hash);
  }
}

function clone(record: EmbedAccessRecord): EmbedAccessRecord {
  return {
    ...record,
    user: { ...record.user },
    scope: { ...record.scope },
    allowedRoots: [...record.allowedRoots],
  };
}

export interface CreateEmbedAccessInput {
  user: EmbedUser;
  apiKey: string;
  productId: string;
  scope: EmbedScope;
  allowedRoots: string[];
  mode: EmbedMode;
  label: string;
  ttlMs?: number;
}

export function createEmbedAccessToken(input: CreateEmbedAccessInput): {
  token: string;
  record: EmbedAccessRecord;
} {
  prune();
  const tokens = store();
  const now = Date.now();
  const own = [...tokens.values()].filter((record) => record.userId === input.user.id);
  if (own.length >= MAX_TOKENS_PER_USER) {
    own.sort((a, b) => a.createdAt - b.createdAt);
    for (const old of own.slice(0, own.length - MAX_TOKENS_PER_USER + 1)) tokens.delete(old.tokenHash);
  }

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, input.ttlMs ?? embedAccessTtlMs()));
  const record: EmbedAccessRecord = {
    id: randomUUID(),
    tokenHash: hashEmbedAccessToken(token),
    userId: input.user.id,
    user: { ...input.user },
    apiKey: input.apiKey,
    productId: input.productId,
    scope: { ...input.scope },
    allowedRoots: [...input.allowedRoots],
    mode: input.mode,
    label: input.label,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  tokens.set(record.tokenHash, record);
  return { token, record: clone(record) };
}

export function getEmbedAccessToken(raw: string): EmbedAccessRecord | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  prune();
  const record = store().get(hashEmbedAccessToken(raw));
  if (!record) return null;
  return clone(record);
}

export function revokeEmbedAccessToken(raw: string): boolean {
  if (!raw.startsWith(TOKEN_PREFIX)) return false;
  return store().delete(hashEmbedAccessToken(raw));
}

/** Drop every access token for a product (membership/config revocation). */
export function revokeEmbedAccessForProduct(productId: string): number {
  let removed = 0;
  for (const [hash, record] of store()) {
    if (record.productId === productId) {
      store().delete(hash);
      removed += 1;
    }
  }
  return removed;
}
