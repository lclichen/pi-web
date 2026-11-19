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
 * Identity: v2 packages are encrypted to the X25519 public key of a per-customer
 * identity. The private key is sealed into the decryption binary at packaging
 * time (apkg-publisher seal) and decrypted only in memory; pi-web never receives
 * it. Only the public metadata (config/apkg-recipient.json) is read here.
 * There is no shared KEK file.
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
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
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
// Recipient public metadata
// ---------------------------------------------------------------------------
//
// v2 的接收方私钥不再以明文文件随发布包分发：打包时由 apkg-publisher seal
// 封进解密二进制，运行时只在内存解密。pi-web 进程只需要公钥元信息
// （config/apkg-recipient.json）用于管理面展示和发布方加密，永远拿不到私钥。

export interface ApkgIdentityInfo {
  configured: boolean;
  id: string | null;
  /** Public key in base64url; safe to show/copy to the publisher. */
  publicKey: string | null;
  /** Dev/test: decryption uses PI_WEB_APKG_IDENTITY directly (not a release). */
  dev?: boolean;
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

function recipientPathCandidates(): string[] {
  const out: string[] = [];
  const envPath = process.env.PI_WEB_APKG_RECIPIENT?.trim();
  if (envPath) out.push(envPath);
  try {
    out.push(join(dataDir(), "apkg-recipient.json"));
  } catch {
    // dataDir unavailable pre-config; package path still applies
  }
  out.push(join(process.cwd(), "config", "apkg-recipient.json"));
  out.push(join(process.cwd(), "..", "config", "apkg-recipient.json"));
  return [...new Set(out)].filter((candidate) => existsSync(candidate));
}

/**
 * Public metadata view for the admin UI. Deliberately returns no file paths or
 * deployment sources — those are internal and not needed by the page.
 */
export function getApkgIdentityInfo(): ApkgIdentityInfo {
  for (const file of recipientPathCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version?: number;
        id?: string;
        publicKey?: string;
      };
      const publicKey = decodeIdentityKey(parsed.publicKey);
      if (!publicKey) continue;
      const id = identityPublicId(publicKey);
      if (typeof parsed.id === "string" && parsed.id && parsed.id !== id) continue;
      return {
        configured: true,
        id,
        publicKey: publicKey.toString("base64url"),
      };
    } catch {
      // unreadable/malformed candidate — try the next location
    }
  }
  // Dev/test fallback: PI_WEB_APKG_IDENTITY points at a private identity JSON.
  // Only the public key is exposed; the path is intentionally not returned.
  const devPath = process.env.PI_WEB_APKG_IDENTITY?.trim();
  if (devPath) {
    try {
      const parsed = JSON.parse(readFileSync(devPath, "utf8")) as { id?: string; publicKey?: string };
      const publicKey = decodeIdentityKey(parsed.publicKey);
      if (publicKey) {
        const id = identityPublicId(publicKey);
        if (!parsed.id || parsed.id === id) {
          return {
            configured: true,
            id,
            publicKey: publicKey.toString("base64url"),
            dev: true,
          };
        }
      }
    } catch {
      // fall through to the generic dev error below
    }
    return {
      configured: false,
      id: null,
      publicKey: null,
      error: "开发身份配置无效。",
    };
  }
  return {
    configured: false,
    id: null,
    publicKey: null,
    error: "当前部署未启用加密配置包支持，请联系管理员。",
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
  // 计数器是服务器侧的许可凭证，裸 writeFileSync 崩溃半写会留下损坏 JSON，
  // 下次读取 fail-open 清零；0600 原子替换（临时文件 + rename）杜绝半写残留。
  writePrivateFileAtomicSync(importStatePath(), JSON.stringify(state, null, 2));
}

export function getApkgImportCount(fingerprint: string): number {
  return readImportState()[fingerprint]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// 进程内按指纹串行化（G1）：checkApkgLicense 与 recordApkgImport 之间隔着
// 解包/落盘的 await，并发导入同一指纹会双双通过 maxImports。锁 key 是指纹
// 本身：同指纹排队是正确性要求，不同指纹并行——导入可能伴随大文件解压，
// 全局单锁会让无关指纹无谓排队。globalThis 惯例同 __piSessions：Next.js
// 热重载后锁链不丢。
// ---------------------------------------------------------------------------

declare global {
  var __piApkgImportLocks: Map<string, Promise<unknown>> | undefined;
}

/**
 * 按指纹串行化 .apkg 导入的 state 读改写。Promise 链锁、不可重入：回调内
 * 不要再调用会拿同一指纹锁的 checkApkgLicense / recordApkgImport /
 * runLicensedApkgImport（会排队等自己）。链排空后清理表项，长期驻留的
 * 只有活跃指纹。
 */
export async function withApkgImportLock<T>(fingerprint: string, fn: () => T | Promise<T>): Promise<T> {
  const locks = (globalThis.__piApkgImportLocks ??= new Map<string, Promise<unknown>>());
  const prev = locks.get(fingerprint) ?? Promise.resolve();
  // 先登记占位再等待：同 tick 的后来者才能链到本任务之后；占位在 finally
  // 里必然 resolve，单个任务失败不会卡死后续排队者。
  let release!: () => void;
  const tail = new Promise<void>((resolve) => (release = resolve));
  locks.set(fingerprint, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(fingerprint) === tail) locks.delete(fingerprint);
  }
}

/** Enforce license terms BEFORE any file is written (throws on violation). */
function enforceApkgLicense(license: ApkgLicense, fingerprint: string, header: ApkgHeader): void {
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
function bumpApkgImport(fingerprint: string): void {
  const state = readImportState();
  const now = new Date().toISOString();
  const entry = state[fingerprint] ?? { count: 0, firstAt: now, lastAt: now };
  entry.count += 1;
  entry.lastAt = now;
  state[fingerprint] = entry;
  writeImportState(state);
}

/** 单独调用也拿指纹锁（防新调用方绕过原子入口）；导入流程请改用 runLicensedApkgImport。 */
export function checkApkgLicense(license: ApkgLicense, fingerprint: string, header: ApkgHeader): Promise<void> {
  return withApkgImportLock(fingerprint, () => {
    enforceApkgLicense(license, fingerprint, header);
  });
}

/** 单独调用也拿指纹锁；语义为"导入成功后计数 +1"。 */
export function recordApkgImport(fingerprint: string): Promise<void> {
  return withApkgImportLock(fingerprint, () => {
    bumpApkgImport(fingerprint);
  });
}

/**
 * .apkg 导入的原子入口：license 检查 → body（校验并落盘）→ 计数递增在
 * 同一把指纹锁内依次执行，并发导入同一指纹不再双双通过 maxImports。
 * body 抛错则不计数（保持"文件落盘成功后才计数"的语义）。解密/解包与
 * 计数器无关，应在调用本函数之前完成——放进锁内只会放大同指纹的排队。
 */
export function runLicensedApkgImport<T>(
  license: ApkgLicense,
  fingerprint: string,
  header: ApkgHeader,
  body: () => T | Promise<T>,
): Promise<T> {
  return withApkgImportLock(fingerprint, async () => {
    enforceApkgLicense(license, fingerprint, header);
    const result = await body();
    bumpApkgImport(fingerprint);
    return result;
  });
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
  // 注册表写坏即锁失效（fail-open），同样走 0600 原子替换，不留半写 JSON。
  writePrivateFileAtomicSync(lockedHomesPath(), JSON.stringify(registry, null, 2));
}

export function isApkgLockedHome(home: string): boolean {
  return readLockedHomes()[projectIdentityKey(home)] !== undefined;
}

/** Export gate: the in-home lock file OR the server-side registry. */
export function isExportLocked(home: string): boolean {
  return isBundleLocked(home) || isApkgLockedHome(home);
}
