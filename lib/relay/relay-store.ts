import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Persists the Local Agent's long-lived connection tokens under the pi agent
// dir with 0o600, mirroring lib/provider-credential-store.ts. A token is the
// single shared secret between the relay and ONE MACHINE; the browser never
// sees it. Survives pi-web restarts so already-paired agents reconnect without
// re-pairing (as long as relay.json is intact).
//
// Multi-machine (2026-09): each paired machine owns its own token. Legacy
// files (tokens: Record<token, number>) are normalized on read.

const WRITE_OPTS = { encoding: "utf-8" as const, mode: 0o600 };

/** Tokens expire (rolling, refreshed on connect) so a stolen machine is not a
 *  permanent credential; re-pairing is cheap (6-char code). */
export const AGENT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface AgentTokenRecord {
  userId: number;
  /** Stable machine id from the agent's config (legacy tokens: null). */
  machineId: string | null;
  /** User-facing label ("工位机" / "实验室服务器"), defaults to hostname. */
  label?: string;
  hostname?: string;
  issuedAt: string;
  lastSeenAt?: string;
  expiresAt?: string;
}

interface RelayFile {
  token: string | null;
  generatedAt: string | null;
  /** Multi-user/multi-machine: agent token -> record. */
  tokens?: Record<string, AgentTokenRecord>;
}

function relayFilePath(): string {
  return join(getAgentDir(), "relay.json");
}

function normalizeRecord(value: unknown): AgentTokenRecord | null {
  // Legacy shape: plain number = owning user id, unknown machine.
  if (typeof value === "number") {
    return { userId: value, machineId: null, issuedAt: new Date(0).toISOString() };
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<AgentTokenRecord>;
  if (typeof v.userId !== "number") return null;
  return {
    userId: v.userId,
    machineId: typeof v.machineId === "string" ? v.machineId : null,
    ...(typeof v.label === "string" && v.label ? { label: v.label } : {}),
    ...(typeof v.hostname === "string" && v.hostname ? { hostname: v.hostname } : {}),
    issuedAt: typeof v.issuedAt === "string" ? v.issuedAt : new Date(0).toISOString(),
    ...(typeof v.lastSeenAt === "string" ? { lastSeenAt: v.lastSeenAt } : {}),
    ...(typeof v.expiresAt === "string" ? { expiresAt: v.expiresAt } : {}),
  };
}

function ensureFile(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ token: null, generatedAt: null } satisfies RelayFile), WRITE_OPTS);
    chmodSync(path, 0o600);
  }
}

function readRelay(path: string): RelayFile {
  ensureFile(path);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as { token?: unknown; generatedAt?: unknown; tokens?: unknown };
      let tokens: Record<string, AgentTokenRecord> | undefined;
      if (obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens)) {
        tokens = {};
        for (const [tok, raw] of Object.entries(obj.tokens as Record<string, unknown>)) {
          const rec = normalizeRecord(raw);
          if (rec && tok) tokens[tok] = rec; // hasOwn-equivalent: only own keys enumerate
        }
      }
      return {
        token: typeof obj.token === "string" ? obj.token : null,
        generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : null,
        // The tokens map MUST survive a read — dropping it would invalidate
        // every previously-issued token and wipe other users' machines.
        ...(tokens ? { tokens } : {}),
      };
    }
  } catch {
    // fall through to empty record
  }
  return { token: null, generatedAt: null };
}

/** Atomic write (tmp+rename): a crash mid-write used to truncate relay.json
 *  and invalidate EVERY machine's token at once. */
function writeRelaySync(path: string, data: RelayFile): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), WRITE_OPTS);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function writeRelay(path: string, data: RelayFile): Promise<void> {
  ensureFile(path);
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error: Error) => {
      compromised = error;
    },
  });
  try {
    if (compromised) throw compromised;
    writeRelaySync(path, data);
    if (compromised) throw compromised;
  } finally {
    try {
      await release();
    } catch {
      // ignore unlock errors; the compromised error above is more useful
    }
  }
}

export interface IssueAgentTokenInput {
  userId: number;
  machineId: string;
  label?: string;
  hostname?: string;
}

/** Generate a fresh 32-byte agent token for one machine, persist (0600), return it. */
export async function issueAgentToken(input: IssueAgentTokenInput): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const path = relayFilePath();
  const data = readRelay(path);
  const tokens = { ...(data.tokens ?? {}) };
  // One live token per MACHINE (a re-pair of the same machine replaces its
  // old token — keyed by machineId inside each record).
  for (const [tok, rec] of Object.entries(tokens)) {
    if (rec.userId === input.userId && rec.machineId === input.machineId) delete tokens[tok];
  }
  const now = new Date().toISOString();
  tokens[token] = {
    userId: input.userId,
    machineId: input.machineId,
    ...(input.label ? { label: input.label } : {}),
    ...(input.hostname ? { hostname: input.hostname } : {}),
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + AGENT_TOKEN_TTL_MS).toISOString(),
  };
  await writeRelay(path, { token, generatedAt: now, tokens });
  return token;
}

/** All token records for persistence-derived views (machine lists). Expired
 *  entries are filtered; hasOwn guards against prototype-chain names. */
export function listAgentTokens(): Array<{ token: string; record: AgentTokenRecord }> {
  const file = readRelay(relayFilePath());
  const out: Array<{ token: string; record: AgentTokenRecord }> = [];
  if (!file.tokens) return out;
  for (const [token, record] of Object.entries(file.tokens)) {
    if (!token) continue;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) continue;
    out.push({ token, record });
  }
  return out;
}

/** Resolve a token to its record (never returns prototype-chain junk). */
function recordForToken(token: string): AgentTokenRecord | null {
  if (!token) return null;
  const file = readRelay(relayFilePath());
  if (file.tokens && Object.prototype.hasOwnProperty.call(file.tokens, token)) {
    const rec = file.tokens[token];
    if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) return null;
    return rec;
  }
  return null;
}

/** Owning web user for a token (0 = unknown / legacy single-token era). */
export function lookupTokenOwner(token: string): number {
  return recordForToken(token)?.userId ?? 0;
}

/** Token record for the WS auth path: owner + machine binding. */
export function lookupTokenRecord(token: string): { userId: number; machineId: string } | null {
  const rec = recordForToken(token);
  if (!rec) return null;
  // Legacy tokens have no machine binding; treat as the user's legacy machine.
  return { userId: rec.userId, machineId: rec.machineId ?? "default" };
}

/** Rolling expiry + lastSeen refresh; called when the machine connects.
 *  Best-effort and throttled by the caller (registry) — failures don't block. */
export async function touchAgentToken(token: string, machineId: string, hostname?: string): Promise<void> {
  const path = relayFilePath();
  const data = readRelay(path);
  if (!data.tokens || !Object.prototype.hasOwnProperty.call(data.tokens, token)) return;
  const rec = data.tokens[token];
  const now = new Date().toISOString();
  data.tokens[token] = {
    ...rec,
    machineId: rec.machineId ?? machineId,
    ...(hostname ? { hostname } : {}),
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + AGENT_TOKEN_TTL_MS).toISOString(),
  };
  await writeRelay(path, data).catch(() => {
    // best-effort freshness
  });
}

/** Rename a machine (label) owned by `userId`. Throws on unknown machine. */
export async function renameAgentMachine(userId: number, machineId: string, label: string): Promise<void> {
  const path = relayFilePath();
  const data = readRelay(path);
  if (!data.tokens) throw new Error("machine not found");
  let hit = false;
  for (const token of Object.keys(data.tokens)) {
    const rec = data.tokens[token]!;
    if (rec.userId === userId && (rec.machineId ?? "default") === machineId) {
      data.tokens[token] = { ...rec, label };
      hit = true;
    }
  }
  if (!hit) throw new Error("machine not found");
  await writeRelay(path, data);
}

/** Revoke a machine's token (unpair). Returns the revoked token or null. */
export async function revokeAgentMachine(userId: number, machineId: string): Promise<string | null> {
  const path = relayFilePath();
  const data = readRelay(path);
  if (!data.tokens) return null;
  let revoked: string | null = null;
  for (const token of Object.keys(data.tokens)) {
    const rec = data.tokens[token]!;
    if (rec.userId === userId && (rec.machineId ?? "default") === machineId) {
      delete data.tokens[token];
      revoked = token;
    }
  }
  if (revoked) await writeRelay(path, data);
  return revoked;
}

/** Constant-time-ish comparison against the legacy single token (auth-off
 *  single-machine era). Per-machine tokens use exact-record lookup above. */
export function isKnownToken(token: string): boolean {
  if (!token) return false;
  if (recordForToken(token)) return true;
  const stored = readRelay(relayFilePath()).token;
  if (!stored || stored.length !== token.length) return false;
  // avoid early-return timing differences
  let diff = 0;
  for (let i = 0; i < stored.length; i++) {
    diff |= stored.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}
