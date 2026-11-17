import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type {
  EmbedMode,
  EmbedScope,
  EmbedTokenRecord,
  EmbedTokenView,
  EmbedUser,
} from "./embed-types.ts";

/**
 * Session-widget embed tokens:
 *   <dataDir>/embed-tokens.json
 *
 * Tokens are bearer credentials for ONE workspace. Only sha256(token) is
 * persisted; the raw URL is shown once at creation. Each token carries an
 * independently minted platform key so it keeps working without a browser
 * cookie and can be revoked without touching the creator's login session.
 */

const FILE_NAME = "embed-tokens.json";
const TOKEN_PREFIX = "emb_";
const DAY_MS = 24 * 60 * 60 * 1000;

export const EMBED_TOKEN_DEFAULT_TTL_MS = 7 * DAY_MS;
export const EMBED_TOKEN_MIN_TTL_MS = 5 * 60 * 1000;
export const EMBED_TOKEN_MAX_TTL_MS = 30 * DAY_MS;
export const MAX_EMBED_TOKENS_PER_USER = 20;

export class EmbedTokenLimitError extends Error {
  constructor() {
    super(`At most ${MAX_EMBED_TOKENS_PER_USER} embed links are allowed per user`);
    this.name = "EmbedTokenLimitError";
  }
}

interface TokenFile {
  version: 1;
  tokens: EmbedTokenRecord[];
}

interface TokenStore {
  path: string;
  mtime: number;
  lastStatAt: number;
  tokens: EmbedTokenRecord[];
}

declare global {
   
  var __piEmbedTokens: TokenStore | undefined;
}

export interface CreateEmbedTokenInput {
  owner: EmbedUser;
  productId: string;
  scope: EmbedScope;
  allowedRoots: string[];
  mode: EmbedMode;
  label: string;
  apiKey: string;
  apiKeyId: number | string;
  ttlMs: number;
}

function filePath(): string {
  return join(dataDir(), FILE_NAME);
}

function cloneRecord(record: EmbedTokenRecord): EmbedTokenRecord {
  return {
    ...record,
    user: { ...record.user },
    scope: { ...record.scope },
    allowedRoots: [...record.allowedRoots],
  };
}

function readStore(): TokenStore {
  const path = filePath();
  const now = Date.now();
  const cached = globalThis.__piEmbedTokens;
  if (cached && cached.path === path && now - cached.lastStatAt < 100) return cached;

  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // Missing file: empty store.
  }
  if (cached && cached.path === path && cached.mtime === mtime) {
    cached.lastStatAt = now;
    return cached;
  }

  let tokens: EmbedTokenRecord[] = [];
  if (mtime > 0) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TokenFile>;
      if (Array.isArray(parsed.tokens)) tokens = parsed.tokens.filter(isTokenRecord);
    } catch {
      tokens = [];
    }
  }

  const next: TokenStore = { path, mtime, lastStatAt: now, tokens };
  globalThis.__piEmbedTokens = next;
  return next;
}

function isTokenRecord(value: unknown): value is EmbedTokenRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<EmbedTokenRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.tokenHash === "string" &&
    typeof record.ownerId === "number" &&
    typeof record.productId === "string" &&
    typeof record.apiKey === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.expiresAt === "number" &&
    Boolean(record.scope) &&
    (record.scope?.kind === "project" || record.scope?.kind === "host") &&
    Array.isArray(record.allowedRoots) &&
    Boolean(record.user)
  );
}

function writeStore(store: TokenStore, tokens: EmbedTokenRecord[]): void {
  const path = filePath();
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, tokens }, null, 2));
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // The write succeeded; staleness only costs one extra parse.
  }
  store.tokens = tokens;
  store.mtime = mtime;
  store.lastStatAt = Date.now();
}

export function hashEmbedToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isExpired(record: EmbedTokenRecord, now = Date.now()): boolean {
  return record.expiresAt <= now;
}

/** Remove expired records and return them so callers can revoke their keys. */
export function pruneExpiredEmbedTokens(now = Date.now()): EmbedTokenRecord[] {
  const store = readStore();
  const kept: EmbedTokenRecord[] = [];
  const removed: EmbedTokenRecord[] = [];
  for (const record of store.tokens) {
    if (isExpired(record, now)) removed.push(cloneRecord(record));
    else kept.push(record);
  }
  if (removed.length > 0) writeStore(store, kept);
  return removed;
}

export function createEmbedToken(input: CreateEmbedTokenInput): { token: string; record: EmbedTokenRecord } {
  const store = readStore();
  const now = Date.now();
  const active = store.tokens.filter((record) => !isExpired(record, now));
  if (active.filter((record) => record.ownerId === input.owner.id).length >= MAX_EMBED_TOKENS_PER_USER) {
    throw new EmbedTokenLimitError();
  }

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const ttlMs = Math.min(EMBED_TOKEN_MAX_TTL_MS, Math.max(EMBED_TOKEN_MIN_TTL_MS, input.ttlMs));
  const record: EmbedTokenRecord = {
    id: randomUUID(),
    tokenHash: hashEmbedToken(token),
    ownerId: input.owner.id,
    user: { ...input.owner },
    productId: input.productId,
    scope: { ...input.scope },
    allowedRoots: [...input.allowedRoots],
    mode: input.mode,
    label: input.label,
    apiKey: input.apiKey,
    apiKeyId: input.apiKeyId,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  writeStore(store, [...active, record]);
  return { token, record: cloneRecord(record) };
}

/** Resolve a raw token. Expired records are removed on the way out. */
export function getEmbedTokenByRaw(raw: string): EmbedTokenRecord | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const store = readStore();
  const hash = hashEmbedToken(raw);
  const record = store.tokens.find((entry) => entry.tokenHash === hash);
  if (!record) return null;
  if (isExpired(record)) {
    writeStore(
      store,
      store.tokens.filter((entry) => entry.id !== record.id),
    );
    return null;
  }
  return cloneRecord(record);
}

export interface EmbedTokenListFilter {
  ownerId?: number;
  includeAll?: boolean;
}

export function listEmbedTokens(filter: EmbedTokenListFilter = {}): EmbedTokenView[] {
  pruneExpiredEmbedTokens();
  return readStore()
    .tokens.filter((record) => filter.includeAll || filter.ownerId === undefined || record.ownerId === filter.ownerId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((record) => ({
      id: record.id,
      ownerId: record.ownerId,
      ownerName: record.user.username,
      productId: record.productId,
      scope: { ...record.scope },
      label: record.label,
      mode: record.mode,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }));
}

/** Remove a token. Owner-only unless `isAdmin`; returns the removed record. */
export function revokeEmbedToken(id: string, ownerId: number, isAdmin = false): EmbedTokenRecord | undefined {
  const store = readStore();
  const record = store.tokens.find((entry) => entry.id === id);
  if (!record) return undefined;
  if (!isAdmin && record.ownerId !== ownerId) return undefined;
  writeStore(
    store,
    store.tokens.filter((entry) => entry.id !== id),
  );
  return cloneRecord(record);
}
