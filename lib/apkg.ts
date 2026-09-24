/**
 * Server-side .apkg support — key store, import counters, bundle locks.
 * Byte format + envelope encryption lives in lib/apkg-format.ts.
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
import { randomBytes } from "node:crypto";
import type { ApkgHeader, ApkgLicense } from "./apkg-format.ts";

export const LOCK_BASENAME = ".bundle-lock.json";

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

/** Generate a fresh KEK and persist it as the given (or a dated) keyId. Publisher-CLI helper. */
export function provisionApkgKey(keyId?: string): { keyId: string; kek: Buffer } {
  const id = keyId ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(2).toString("hex")}`;
  const kek = randomBytes(32);
  const existing = existsSync(keysFilePath())
    ? (() => { try { return JSON.parse(readFileSync(keysFilePath(), "utf8")) as Record<string, string>; } catch { return {}; } })()
    : {};
  existing[id] = kek.toString("base64");
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(keysFilePath(), JSON.stringify(existing, null, 2), { mode: 0o600 });
  try { chmodSync(keysFilePath(), 0o600); } catch { /* fs without chmod */ }
  return { keyId: id, kek };
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
