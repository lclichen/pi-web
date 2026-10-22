/**
 * Server-side .apkg support — key store, import counters, bundle locks, and
 * the display-only header parse.
 *
 * This module is deliberately free of envelope cryptography: the decrypt
 * implementation lives in the internal `apkg-publisher` binary, invoked as a
 * subprocess by lib/apkg-open.ts (decryption oracle). What remains here is
 * the plaintext header region (magic + display metadata + keyId) and the
 * policy layer around imports.
 *
 * Key store: <dataDir>/apkg-keys.json maps keyId → base64 KEK (0600). The
 * PI_WEB_APKG_KEYS env var accepts the same JSON and is merged over the file
 * (container deployments prefer env). Removing a keyId revokes every package
 * wrapped with that generation.
 *
 * Import counter: <dataDir>/apkg-imports.json tracks per-fingerprint import
 * counts — the server-side half of `license.maxImports`. Honest boundary
 * (commercial-protection.md): the counter binds one pi-web server; a file
 * copied to another server starts a fresh counter. It raises the bar against
 * casual redistribution, not against a determined operator.
 *
 * Bundle lock: after an .apkg import the project home carries
 * .pi/.bundle-lock.json; both export routes refuse to re-export locked
 * homes (the lock basename is also in the bundle DENIED list, so a plain
 * bundle can never carry or strip it).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";
import { projectIdentityKey } from "./project-identity.ts";

export const LOCK_BASENAME = ".bundle-lock.json";

// ---------------------------------------------------------------------------
// Display-only header (plaintext region of the envelope)
// ---------------------------------------------------------------------------

const APKG_MAGIC = Buffer.concat([Buffer.from("APKG1", "utf8"), Buffer.alloc(11)]);
const APKG_FORMAT_VERSION = 1;
const KEY_ID_BYTES = 16;

/** Display + authorization metadata carried by a package. */
export interface ApkgPackageMeta {
  /** Stable slug (bundle/preset name). */
  name: string;
  /** Human title shown in import UI. */
  title: string;
  description: string;
  /** Content version (semver-ish string, e.g. "1.2.0") — NOT the format version. */
  version: string;
  channel: "stable" | "alpha" | "beta" | string;
}

/** Authoritative license terms (inside the encrypted manifest). */
export interface ApkgLicense {
  /** ISO date — imports rejected after this moment. */
  expiresAt?: string;
  /** Max imports per pi-web server (anti-casual-redistribution counter). */
  maxImports?: number;
}

export interface ApkgHeader extends ApkgPackageMeta {
  keyId: string;
  license: ApkgLicense;
}

/** Quick magic check — cheap enough for upload routing decisions. */
export function isApkgBytes(data: Buffer): boolean {
  return data.length > APKG_MAGIC.length && data.subarray(0, APKG_MAGIC.length).equals(APKG_MAGIC);
}

/**
 * Parse the plaintext header (display-only, untrusted; throws on malformed
 * files). The authoritative license copy lives inside the encrypted
 * manifest, tamper-proof under publisher key secrecy.
 */
export function readApkgHeader(data: Buffer): ApkgHeader {
  if (!isApkgBytes(data)) throw new Error("不是 .apkg 加密配置包");
  let offset = APKG_MAGIC.length;
  const formatVersion = data.readUInt16LE(offset);
  if (formatVersion !== APKG_FORMAT_VERSION) {
    throw new Error(`不支持的 .apkg 格式版本: ${formatVersion}`);
  }
  offset += 2;
  const headerLength = data.readUInt16LE(offset);
  offset += 2;
  const headerJson = data.subarray(offset, offset + headerLength).toString("utf8");
  offset += headerLength;
  const keyIdBuf = data.subarray(offset, offset + KEY_ID_BYTES);
  const keyId = keyIdBuf.subarray(0, keyIdBuf.indexOf(0)).toString("utf8");
  let header: ApkgHeader;
  try {
    header = JSON.parse(headerJson) as ApkgHeader;
  } catch {
    throw new Error("包元信息损坏");
  }
  return { ...header, keyId };
}

export interface BundleLock {
  apkg: true;
  keyId: string;
  fingerprint: string;
  importedAt: string;
}

// ---------------------------------------------------------------------------
// Key store
// ---------------------------------------------------------------------------

function keysFilePath(): string {
  return join(dataDir(), "apkg-keys.json");
}

/** Load KEKs from the dataDir file plus the PI_WEB_APKG_KEYS env override. */
export function getApkgKeys(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const sources: string[] = [];
  if (existsSync(keysFilePath())) {
    try {
      sources.push(readFileSync(keysFilePath(), "utf8"));
    } catch {
      // unreadable — fall through to env
    }
  }
  if (process.env.PI_WEB_APKG_KEYS) sources.push(process.env.PI_WEB_APKG_KEYS);
  for (const source of sources) {
    try {
      const parsed = JSON.parse(source) as Record<string, string>;
      for (const [keyId, b64] of Object.entries(parsed)) {
        if (typeof b64 === "string" && b64.length > 0) {
          const kek = Buffer.from(b64, "base64");
          if (kek.length === 32) out[keyId] = kek;
        }
      }
    } catch {
      // malformed source — skip it entirely
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import counter
// ---------------------------------------------------------------------------

interface ImportState {
  [fingerprint: string]: { count: number; firstAt: string; lastAt: string };
}

function importStatePath(): string {
  return join(dataDir(), "apkg-imports.json");
}

function readImportState(): ImportState {
  try {
    return JSON.parse(readFileSync(importStatePath(), "utf8")) as ImportState;
  } catch {
    return {};
  }
}

function writeImportState(state: ImportState): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(importStatePath(), JSON.stringify(state, null, 2));
}

export function getApkgImportCount(fingerprint: string): number {
  return readImportState()[fingerprint]?.count ?? 0;
}

/** Enforce license terms BEFORE any file is written (throws on violation). */
export function checkApkgLicense(license: ApkgLicense, fingerprint: string, header: ApkgHeader): void {
  if (license.expiresAt) {
    const expiry = Date.parse(license.expiresAt);
    if (Number.isFinite(expiry) && Date.now() > expiry) {
      throw new Error(`配置包授权已过期（${license.expiresAt.slice(0, 10)}，包 ${header.name} v${header.version}）`);
    }
  }
  if (typeof license.maxImports === "number" && license.maxImports >= 0) {
    const used = getApkgImportCount(fingerprint);
    if (used >= license.maxImports) {
      throw new Error(`配置包导入次数已达上限（${used}/${license.maxImports}，包 ${header.name} v${header.version}）`);
    }
  }
}

/** Record a successful import AFTER the files landed. */
export function recordApkgImport(fingerprint: string): void {
  const state = readImportState();
  const now = new Date().toISOString();
  const entry = state[fingerprint] ?? { count: 0, firstAt: now, lastAt: now };
  entry.count += 1;
  entry.lastAt = now;
  state[fingerprint] = entry;
  writeImportState(state);
}

// ---------------------------------------------------------------------------
// Bundle lock (no re-export of imported .apkg content)
// ---------------------------------------------------------------------------

export function bundleLockPath(home: string): string {
  return join(home, ".pi", LOCK_BASENAME);
}

export function isBundleLocked(home: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(bundleLockPath(home), "utf8")) as Partial<BundleLock>;
    return parsed.apkg === true;
  } catch {
    return false;
  }
}

export function writeBundleLock(home: string, lock: BundleLock): void {
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(bundleLockPath(home), JSON.stringify(lock, null, 2));
}

// ---------------------------------------------------------------------------
// Server-side locked-homes registry
//
// The in-home lock file alone cannot survive the session's own agent: its
// bash/write/edit tools run with the project home as cwd, so ".pi/ is inside
// the agent's write range and "delete the lock" is one prompt away. This
// registry lives in the server dataDir — OUTSIDE every project home and thus
// outside the agent's write fence — and the export routes consult it in
// addition to the lock file (either hit ⇒ refuse). What it does NOT cover is
// the documented honest boundary: an agent can still tar the plaintext and
// the user can download it via the file viewer.
// ---------------------------------------------------------------------------

interface LockedHomeEntry {
  fingerprint: string;
  keyId: string;
  importedAt: string;
}

function lockedHomesPath(): string {
  return join(dataDir(), "apkg-locked-homes.json");
}

function readLockedHomes(): Record<string, LockedHomeEntry> {
  try {
    return JSON.parse(readFileSync(lockedHomesPath(), "utf8")) as Record<string, LockedHomeEntry>;
  } catch {
    return {};
  }
}

/** Server-side half of the no-re-export lock; survives agent-side tampering. */
export function recordApkgLockedHome(home: string, entry: LockedHomeEntry): void {
  const registry = readLockedHomes();
  registry[projectIdentityKey(home)] = entry;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(lockedHomesPath(), JSON.stringify(registry, null, 2));
}

export function isApkgLockedHome(home: string): boolean {
  return readLockedHomes()[projectIdentityKey(home)] !== undefined;
}

/** Export gate: the in-home lock file OR the server-side registry. */
export function isExportLocked(home: string): boolean {
  return isBundleLocked(home) || isApkgLockedHome(home);
}
