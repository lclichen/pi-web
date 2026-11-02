/**
 * Share-link store — one-file, time- and download-limited tokens
 * (docs/dev/mcp-file-sharing.md).
 *
 * Model:
 *   · host shares    — live: the GET re-reads the server file, re-fenced
 *                      against the root that authorized the share (symlink
 *                      swaps after creation cannot escape).
 *   · snapshot shares — the bytes are copied under <dataDir>/share-files/ at
 *                      CREATION time (sandbox/local-machine/ssh files). This
 *                      deliberately deviates from the original "proxy at GET"
 *                      sketch: proxying would require the user's platform API
 *                      key or relay credentials at fetch time (no cookie on
 *                      the consumer side), which expands the blast radius of
 *                      the store. A snapshot needs no credentials, survives
 *                      container/agent restarts, and gives the MCP consumer
 *                      deterministic content.
 *
 * Tokens are 128-bit random, stored ONLY as sha256 — the store never keeps the
 * bearer string. Metadata persists to <dataDir>/shares.json (atomic, 0600);
 * expired entries and orphaned snapshot files are swept lazily.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { dataDir } from "./mode-homes.ts";

export const SHARE_TTL_DEFAULT_MIN = 30;
export const SHARE_TTL_MAX_MIN = 24 * 60;
export const SHARE_DOWNLOADS_DEFAULT = 10;
export const SHARE_DOWNLOADS_MAX = 100;
/** Per-file size cap for shares (host stat / snapshot bytes). */
export const SHARE_MAX_BYTES = Number(process.env.PI_WEB_SHARE_MAX_BYTES ?? 100 * 1024 * 1024);
/** Creation rate limit per user. */
export const SHARE_CREATE_PER_HOUR = 30;
/** Concurrently active shares per user. */
export const SHARE_ACTIVE_MAX = 50;

export interface ShareEntry {
  /** sha256(token) hex — the bearer token itself is never stored. */
  tokenHash: string;
  /** Display path as shared (what the creator asked for). */
  path: string;
  fileName: string;
  kind: "host" | "snapshot";
  /** host: absolute file path + the allowed root that authorized it. */
  hostPath?: string;
  hostRoot?: string;
  /** snapshot: recorded mime + byte size (file lives in shareDir()). */
  mime?: string;
  size: number;
  /** Remote session the file came from (snapshot shares), for audit. */
  srcSession?: string;
  ownerId: number;
  ownerName: string;
  /** Creating session (set by the share_file tool). */
  sessionId?: string;
  createdAt: number;
  expiresAt: number;
  maxDownloads: number;
  downloads: number;
  lastDownloadAt?: number;
  lastIp?: string;
}

export interface CreateShareInput {
  path: string;
  fileName: string;
  ownerId: number;
  ownerName: string;
  sessionId?: string;
  srcSession?: string;
  ttlMinutes?: number;
  maxDownloads?: number;
  oneTime?: boolean;
  /** Host share: live file (must already be fenced/validated by the caller). */
  host?: { hostPath: string; hostRoot: string; size: number };
  /** Snapshot share: bytes captured now (size already capped by the caller). */
  snapshot?: { bytes: Buffer; mime: string };
}

export type ShareLookup =
  { status: "ok"; entry: ShareEntry } | { status: "missing" } | { status: "expired" } | { status: "exhausted" };

interface StoreState {
  entries: Map<string, ShareEntry>;
  /** ownerId → { count, windowStart } creation rate window. */
  rate: Map<number, { count: number; windowStart: number }>;
  loaded: boolean;
}

declare global {
  var __piShareStore: StoreState | undefined;
}

/** Test seam: inject the clock so expiry can be asserted without sleeps. */
let nowFn: () => number = () => Date.now();
export function setShareClockForTesting(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

function store(): StoreState {
  if (!globalThis.__piShareStore) {
    globalThis.__piShareStore = { entries: new Map(), rate: new Map(), loaded: false };
  }
  const s = globalThis.__piShareStore;
  if (!s.loaded) {
    s.loaded = true;
    loadFromDisk(s);
  }
  return s;
}

/** Drop all state (tests only). */
export function resetShareStoreForTesting(): void {
  globalThis.__piShareStore = undefined;
}

function metaPath(): string {
  return join(dataDir(), "shares.json");
}

function shareDir(): string {
  return join(dataDir(), "share-files");
}

function snapshotPath(tokenHash: string): string {
  return join(shareDir(), tokenHash + ".bin");
}

function loadFromDisk(s: StoreState): void {
  try {
    const raw = JSON.parse(readFileSync(metaPath(), "utf8")) as { shares?: ShareEntry[] };
    const now = nowFn();
    for (const e of raw.shares ?? []) {
      if (!e || typeof e.tokenHash !== "string") continue;
      if (e.expiresAt <= now) {
        rmSync(snapshotPath(e.tokenHash), { force: true });
        continue;
      }
      // Drop snapshot entries whose file vanished (manual cleanup).
      if (e.kind === "snapshot" && !existsSync(snapshotPath(e.tokenHash))) continue;
      s.entries.set(e.tokenHash, e);
    }
  } catch {
    // absent/corrupt metadata — start empty
  }
  // Sweep orphaned snapshot files not referenced by any entry.
  try {
    const referenced = new Set([...s.entries.values()].filter((e) => e.kind === "snapshot").map((e) => e.tokenHash));
    for (const name of readdirSync(shareDir())) {
      const m = /^([0-9a-f]{64})\.bin$/.exec(name);
      if (m && !referenced.has(m[1])) rmSync(join(shareDir(), name), { force: true });
    }
  } catch {
    // no share dir yet
  }
}

function persist(s: StoreState): void {
  mkdirSync(dataDir(), { recursive: true });
  const shares = [...s.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  writePrivateFileAtomicSync(metaPath(), JSON.stringify({ shares }, null, 2));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sweepExpired(s: StoreState): void {
  const now = nowFn();
  let changed = false;
  for (const [hash, e] of s.entries) {
    if (e.expiresAt <= now) {
      if (e.kind === "snapshot") rmSync(snapshotPath(hash), { force: true });
      s.entries.delete(hash);
      changed = true;
    }
  }
  if (changed) persist(s);
}

export class ShareLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareLimitError";
  }
}

/** Atomic 0600 write for BINARY snapshot payloads (the shared atomic writer
 *  is string-only): temp file in the same directory, then rename. */
function writeSnapshotFile(path: string, bytes: Buffer): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function createShare(input: CreateShareInput): { token: string; entry: ShareEntry } {
  const s = store();
  sweepExpired(s);
  const now = nowFn();

  if (!input.host && !input.snapshot) throw new Error("share needs either host or snapshot payload");
  if (input.host && input.snapshot) throw new Error("share cannot be both host and snapshot");

  // Per-user guards: active count + creation rate.
  const active = [...s.entries.values()].filter((e) => e.ownerId === input.ownerId).length;
  if (active >= SHARE_ACTIVE_MAX) {
    throw new ShareLimitError(`活跃分享过多（≥${SHARE_ACTIVE_MAX}）：请先撤销或等待过期`);
  }
  const rate = s.rate.get(input.ownerId) ?? { count: 0, windowStart: now };
  if (now - rate.windowStart >= 3_600_000) {
    rate.count = 0;
    rate.windowStart = now;
  }
  rate.count += 1;
  s.rate.set(input.ownerId, rate);
  if (rate.count > SHARE_CREATE_PER_HOUR) {
    throw new ShareLimitError(`创建过于频繁（>${SHARE_CREATE_PER_HOUR}/小时）：请稍后再试`);
  }

  const ttl = Math.min(Math.max(Math.floor(input.ttlMinutes ?? SHARE_TTL_DEFAULT_MIN), 1), SHARE_TTL_MAX_MIN);
  const maxDownloads = input.oneTime
    ? 1
    : Math.min(Math.max(Math.floor(input.maxDownloads ?? SHARE_DOWNLOADS_DEFAULT), 1), SHARE_DOWNLOADS_MAX);

  const token = randomBytes(16).toString("base64url");
  const tokenHash = hashToken(token);
  const entry: ShareEntry = {
    tokenHash,
    path: input.path,
    fileName: input.fileName,
    kind: input.host ? "host" : "snapshot",
    // Host fields dropped here during an earlier type fix — the GET fence then
    // saw undefined paths and answered 410 for perfectly valid host shares.
    ...(input.host ? { hostPath: input.host.hostPath, hostRoot: input.host.hostRoot } : {}),
    size: input.host ? input.host.size : input.snapshot!.bytes.length,
    ...(input.snapshot ? { mime: input.snapshot.mime } : {}),
    ...(input.srcSession ? { srcSession: input.srcSession } : {}),
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    createdAt: now,
    expiresAt: now + ttl * 60_000,
    maxDownloads,
    downloads: 0,
  };

  if (input.snapshot) {
    mkdirSync(shareDir(), { recursive: true });
    writeSnapshotFile(snapshotPath(tokenHash), input.snapshot.bytes);
  }
  s.entries.set(tokenHash, entry);
  persist(s);
  return { token, entry };
}

export function lookupShare(token: string): ShareLookup {
  const s = store();
  const tokenHash = hashToken(token);
  const entry = s.entries.get(tokenHash);
  if (!entry) {
    // Not found as-is: could have expired between persists — sweep once so a
    // stale in-memory copy cannot outlive its TTL, then retry.
    sweepExpired(s);
    const retried = s.entries.get(tokenHash);
    if (!retried) return { status: "missing" };
    return finalizeLookup(s, retried);
  }
  return finalizeLookup(s, entry);
}

function finalizeLookup(s: StoreState, entry: ShareEntry): ShareLookup {
  const now = nowFn();
  if (entry.expiresAt <= now) {
    // Report "expired" once, then drop it (the next lookup says missing).
    s.entries.delete(entry.tokenHash);
    if (entry.kind === "snapshot") rmSync(snapshotPath(entry.tokenHash), { force: true });
    persist(s);
    return { status: "expired" };
  }
  if (entry.downloads >= entry.maxDownloads) return { status: "exhausted" };
  return { status: "ok", entry };
}

/** Count one download. Returns false when the quota is already exhausted. */
export function consumeShareDownload(token: string, ip?: string): boolean {
  const s = store();
  const tokenHash = hashToken(token);
  const entry = s.entries.get(tokenHash);
  if (!entry) return false;
  if (entry.downloads >= entry.maxDownloads) return false;
  entry.downloads += 1;
  entry.lastDownloadAt = nowFn();
  if (ip) entry.lastIp = ip.slice(0, 64);
  persist(s);
  return true;
}

export function revokeShare(
  token: string,
  actor: { ownerId: number; isAdmin: boolean },
): "ok" | "missing" | "forbidden" {
  const s = store();
  sweepExpired(s);
  const tokenHash = hashToken(token);
  const entry = s.entries.get(tokenHash);
  if (!entry) return "missing";
  if (!actor.isAdmin && entry.ownerId !== actor.ownerId) return "forbidden";
  s.entries.delete(tokenHash);
  if (entry.kind === "snapshot") rmSync(snapshotPath(tokenHash), { force: true });
  persist(s);
  return "ok";
}

/** Delete a share by hash (internal: e.g. host file escaped its fence). */
export function dropShareByHash(tokenHash: string): void {
  const s = store();
  if (!s.entries.delete(tokenHash)) return;
  rmSync(snapshotPath(tokenHash), { force: true });
  persist(s);
}

/** Audit view. Admin sees everything; users see their own. */
export function listShares(actor: { ownerId: number; isAdmin: boolean }): ShareEntry[] {
  const s = store();
  sweepExpired(s);
  return [...s.entries.values()]
    .filter((e) => actor.isAdmin || e.ownerId === actor.ownerId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Snapshot file path for serving (exists for kind=snapshot entries). */
export function shareSnapshotPath(entry: ShareEntry): string {
  return snapshotPath(entry.tokenHash);
}

/** Host share fence at GET time: the file must still be a real file inside the
 *  root that authorized the share — a symlink swapped in after creation (or a
 *  workspace symlink retargeted outside) is refused and the share is dropped. */
export function hostShareStillFenced(entry: ShareEntry): boolean {
  if (entry.kind !== "host" || !entry.hostPath || !entry.hostRoot) return false;
  try {
    if (!statSync(entry.hostPath).isFile()) return false;
    return isWithinRoot(entry.hostPath, entry.hostRoot);
  } catch {
    return false;
  }
}

/** Symlink-resolved containment (same approach as lib/file-access fences). */
function isWithinRoot(child: string, root: string): boolean {
  try {
    const c = realpathSync(child);
    const r = realpathSync(root);
    if (c === r) return true;
    const sep = c.includes("\\") ? "\\" : "/";
    return c.startsWith(r.endsWith(sep) ? r : r + sep);
  } catch {
    return false;
  }
}
