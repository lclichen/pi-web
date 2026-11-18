/**
 * Server-side .apkg support — recipient identity, import counters, bundle
 * locks, and the display-only header parse.
 *
 * This module is deliberately free of envelope cryptography: the decrypt
 * implementation lives in the internal `apkg-publisher` binary, invoked as a
 * subprocess by lib/apkg-open.ts (decryption oracle). What remains here is
 * the plaintext header region (magic + display metadata + recipient id) and
 * the policy layer around imports.
 *
 * Identity: v2 packages are encrypted to the X25519 public key of an identity
 * whose private key ships inside the pi-web release (config/apkg-identity.json,
 * <dataDir>/apkg-identity.json, or PI_WEB_APKG_IDENTITY). The admin UI shows
 * only the id/public key — never the private key. There is no shared KEK file.
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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";
import { projectIdentityKey } from "./project-identity.ts";

export const LOCK_BASENAME = ".bundle-lock.json";

// ---------------------------------------------------------------------------
// Display-only header (plaintext region of the envelope)
// ---------------------------------------------------------------------------

const APKG_MAGIC = Buffer.concat([Buffer.from("APKG2", "utf8"), Buffer.alloc(11)]);
const APKG_FORMAT_VERSION = 2;

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
  /** 接收方身份指纹（r_ + 16 hex），由发布方用本机 identity 公钥加密时写入。 */
  recipient: string;
  license: ApkgLicense;
}

/** Quick magic check — cheap enough for upload routing decisions. */
export function isApkgBytes(data: Buffer): boolean {
  return data.length > APKG_MAGIC.length && data.subarray(0, APKG_MAGIC.length).equals(APKG_MAGIC);
}

/**
 * Parse the plaintext header (display-only, untrusted; throws on malformed
 * files). v2 header 不含文件清单；authoritative license 仍在加密 manifest。
 */
export function readApkgHeader(data: Buffer): ApkgHeader {
  if (!isApkgBytes(data)) throw new Error("不是 .apkg 加密配置包");
  let offset = APKG_MAGIC.length;
  if (data.length < offset + 4) throw new Error("包元信息损坏");
  const formatVersion = data.readUInt16LE(offset);
  if (formatVersion !== APKG_FORMAT_VERSION) {
    throw new Error(`不支持的 .apkg 格式版本: ${formatVersion}`);
  }
  offset += 2;
  const headerLength = data.readUInt16LE(offset);
  offset += 2;
  if (headerLength <= 0 || headerLength > 4096 || data.length < offset + headerLength) {
    throw new Error("包元信息损坏");
  }
  const headerJson = data.subarray(offset, offset + headerLength).toString("utf8");
  let header: ApkgHeader;
  try {
    header = JSON.parse(headerJson) as ApkgHeader;
  } catch {
    throw new Error("包元信息损坏");
  }
  if (typeof header.name !== "string" || typeof header.title !== "string" || typeof header.recipient !== "string") {
    throw new Error("包元信息损坏");
  }
  return header;
}

export interface BundleLock {
  apkg: true;
  recipient: string;
  fingerprint: string;
  importedAt: string;
}

// ---------------------------------------------------------------------------
// Recipient identity
// ---------------------------------------------------------------------------
//
// v2 不再使用共享 KEK：pi-web 发布包里内嵌一份 X25519 私钥
// （config/apkg-identity.json 或部署注入），发布方用对应公钥加密 .apkg。
// 私钥永远不会通过 API/UI 回显；管理面只展示 id、公钥和来源。

export interface ApkgIdentity {
  version: number;
  id: string;
  publicKey: string;
  privateKey: string;
}

export type ApkgIdentitySource = "env" | "data" | "package";

export interface ApkgIdentityInfo {
  configured: boolean;
  id: string | null;
  /** Public key in base64url; safe to show/copy to the publisher. */
  publicKey: string | null;
  source: ApkgIdentitySource | null;
  path: string | null;
  error?: string;
}

function decodeIdentityKey(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  try {
    const buf = Buffer.from(normalized, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function identityPublicId(publicKey: Buffer): string {
  return `r_${createHash("sha256").update(publicKey).digest("hex").slice(0, 16)}`;
}

interface ResolvedIdentityPath {
  path: string;
  source: ApkgIdentitySource;
}

function identityPathCandidates(): ResolvedIdentityPath[] {
  const out: ResolvedIdentityPath[] = [];
  const envPath = process.env.PI_WEB_APKG_IDENTITY?.trim();
  if (envPath) out.push({ path: envPath, source: "env" });
  try {
    out.push({ path: join(dataDir(), "apkg-identity.json"), source: "data" });
  } catch {
    // dataDir unavailable pre-config; package path still applies
  }
  out.push({ path: join(process.cwd(), "config", "apkg-identity.json"), source: "package" });
  out.push({ path: join(process.cwd(), "..", "config", "apkg-identity.json"), source: "package" });
  const seen = new Set<string>();
  return out.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return existsSync(candidate.path);
  });
}

/** Absolute path of the embedded recipient identity, or null. */
export function resolveApkgIdentityPath(): ResolvedIdentityPath | null {
  return identityPathCandidates()[0] ?? null;
}

/** Load and validate the private identity. Never expose the private key. */
export function loadApkgIdentity(): { path: string; source: ApkgIdentitySource; identity: ApkgIdentity } | null {
  for (const candidate of identityPathCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(candidate.path, "utf8")) as Partial<ApkgIdentity>;
      const privateKey = decodeIdentityKey(parsed.privateKey);
      const publicKey = decodeIdentityKey(parsed.publicKey);
      if (!privateKey || !publicKey) continue;
      const id = identityPublicId(publicKey);
      if (typeof parsed.id === "string" && parsed.id && parsed.id !== id) continue;
      return {
        path: candidate.path,
        source: candidate.source,
        identity: {
          version: 2,
          id,
          publicKey: publicKey.toString("base64url"),
          privateKey: privateKey.toString("base64url"),
        },
      };
    } catch {
      // unreadable/malformed candidate — try the next location
    }
  }
  return null;
}

/** Metadata-only identity view for the admin UI (no private key). */
export function getApkgIdentityInfo(): ApkgIdentityInfo {
  const found = loadApkgIdentity();
  if (!found) {
    return {
      configured: false,
      id: null,
      publicKey: null,
      source: null,
      path: null,
      ...(identityPathCandidates().length === 0
        ? { error: "未找到 apkg-identity.json；请把发布包内嵌身份放到 <数据目录>/apkg-identity.json" }
        : { error: "apkg-identity.json 存在但格式无效" }),
    };
  }
  return {
    configured: true,
    id: found.identity.id,
    publicKey: found.identity.publicKey,
    source: found.source,
    path: found.path,
  };
}

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
  recipient: string;
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
