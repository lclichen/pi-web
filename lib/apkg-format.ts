/**
 * .apkg — encrypted config package format (commercial-protection.md §一).
 *
 * Pure byte format + envelope encryption. No filesystem access — paths and
 * key stores live in lib/apkg.ts (server) and scripts/pack-apkg.ts
 * (publisher CLI), which both import this module.
 *
 * Layout (all integers little-endian):
 *
 *   off   size  field
 *   0     16    magic "APKG1" + NUL padding
 *   16    2     formatVersion = 1
 *   18    2     headerLength
 *   20    N     header JSON (UTF-8, display-only, ≤4KB)
 *   20+N  16    keyId (UTF-8, NUL-padded — which KEK generation wraps the DEK)
 *   36+N  12    contentNonce
 *   48+N  C     contentCiphertext = AES-256-GCM(DEK, contentNonce, zipBytes)
 *   ..    16    contentTag
 *   ..    12    dekNonce
 *   ..    48    wrappedDek = AES-256-GCM(KEK, dekNonce, DEK) → 32B ct + 16B tag
 *
 * Envelope encryption: a fresh 256-bit DEK encrypts each package; the DEK is
 * wrapped with a publisher-held KEK (keyId names the generation, enabling
 * rotation/revocation). The plaintext header carries display-only metadata
 * (untrusted — the authoritative license copy lives inside the encrypted
 * zip's manifest.json `apkg` block, tamper-proof under KEK secrecy).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import JSZip from "jszip";

export const APKG_MAGIC = Buffer.concat([Buffer.from("APKG1", "utf8"), Buffer.alloc(11)]);
export const APKG_FORMAT_VERSION = 1;
const KEY_ID_BYTES = 16;
const NONCE_BYTES = 12;
const DEK_BYTES = 32;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4096;

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

export interface PackApkgOptions {
  package: ApkgPackageMeta;
  license?: ApkgLicense;
  kek: Buffer;
  keyId: string;
}

export interface OpenApkgResult {
  zip: Buffer;
  keyId: string;
  fingerprint: string;
  header: ApkgHeader;
}

function gcmSeal(key: Buffer, nonce: Buffer, plaintext: Buffer): { ciphertext: Buffer; tag: Buffer } {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function gcmOpen(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Quick magic check — cheap enough for upload routing decisions. */
export function isApkgBytes(data: Buffer): boolean {
  return data.length > APKG_MAGIC.length && data.subarray(0, APKG_MAGIC.length).equals(APKG_MAGIC);
}

function padKeyId(keyId: string): Buffer {
  const buf = Buffer.alloc(KEY_ID_BYTES, 0);
  const bytes = Buffer.from(keyId, "utf8");
  if (bytes.length > KEY_ID_BYTES) throw new Error(`keyId 过长（≤${KEY_ID_BYTES} 字节）: ${keyId}`);
  bytes.copy(buf, 0);
  return buf;
}

/**
 * Wrap a plain config-bundle zip into an .apkg envelope.
 *
 * The manifest.json inside the zip is rewritten to carry the authoritative
 * `package` + `apkg.license` blocks (merged over whatever the exporter put
 * there), so display metadata and enforced terms cannot disagree.
 */
export async function packApkg(zipBytes: Buffer, options: PackApkgOptions): Promise<{ bytes: Buffer; fingerprint: string }> {
  const meta = options.package;
  if (!meta.name || !meta.title) throw new Error("package name/title 不能为空");
  if (options.kek.length !== DEK_BYTES) throw new Error(`KEK 必须为 ${DEK_BYTES} 字节（AES-256）`);

  // Rewrite the manifest inside the zip so the encrypted copy is authoritative.
  let payload = zipBytes;
  try {
    const zip = await JSZip.loadAsync(zipBytes);
    let manifest: Record<string, unknown> = {};
    const existing = zip.file("manifest.json");
    if (existing) {
      try {
        manifest = JSON.parse((await existing.async("string")) as string) as Record<string, unknown>;
      } catch {
        manifest = {};
      }
    }
    manifest.package = {
      name: meta.name,
      title: meta.title,
      description: meta.description ?? "",
      version: meta.version ?? "1.0.0",
      channel: meta.channel ?? "stable",
    };
    manifest.apkg = {
      keyId: options.keyId,
      license: options.license ?? {},
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    payload = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  } catch (error) {
    throw new Error(`无法处理包内容（需要 zip 格式的配置包）: ${error instanceof Error ? error.message : String(error)}`);
  }

  const dek = randomBytes(DEK_BYTES);
  const contentNonce = randomBytes(NONCE_BYTES);
  const sealed = gcmSeal(dek, contentNonce, payload);
  const dekNonce = randomBytes(NONCE_BYTES);
  const wrappedDek = gcmSeal(options.kek, dekNonce, dek);

  // The header is display-only metadata; the package fingerprint (identity
  // for locks/counters) is sha256 of the whole file and deliberately NOT
  // embedded here — a value cannot cover its own hash.
  const header: ApkgHeader = {
    ...meta,
    description: meta.description ?? "",
    version: meta.version ?? "1.0.0",
    channel: meta.channel ?? "stable",
    keyId: options.keyId,
    license: options.license ?? {},
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  if (headerJson.length > MAX_HEADER_BYTES) throw new Error(`包元信息过大（>${MAX_HEADER_BYTES}B）`);

  const headerLen = Buffer.alloc(2);
  headerLen.writeUInt16LE(headerJson.length, 0);
  const bytes = Buffer.concat([
    APKG_MAGIC,
    Buffer.from([APKG_FORMAT_VERSION & 0xff, (APKG_FORMAT_VERSION >> 8) & 0xff]),
    headerLen,
    headerJson,
    padKeyId(options.keyId),
    contentNonce,
    sealed.ciphertext,
    sealed.tag,
    dekNonce,
    wrappedDek.ciphertext,
    wrappedDek.tag,
  ]);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  return { bytes, fingerprint };
}

/** Parse the plaintext header (display-only; throws on malformed files). */
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

/**
 * Decrypt an .apkg back to the plain zip bytes.
 * `keys` maps keyId → KEK; a package wrapped with an unknown generation is
 * rejected (revocation by key removal).
 */
export function openApkgBytes(data: Buffer, keys: Record<string, Buffer>): OpenApkgResult {
  const header = readApkgHeader(data);
  const kek = keys[header.keyId];
  if (!kek || kek.length !== DEK_BYTES) {
    throw new Error(`服务器未配置该配置包的解密密钥（keyId=${header.keyId}，请联系发布方）`);
  }
  const headerLength = data.readUInt16LE(APKG_MAGIC.length + 2);
  let offset = APKG_MAGIC.length + 2 + 2 + headerLength + KEY_ID_BYTES;

  const contentNonce = data.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const ciphertextEnd = data.length - NONCE_BYTES - DEK_BYTES - TAG_BYTES - TAG_BYTES;
  const contentCiphertext = data.subarray(offset, ciphertextEnd);
  const contentTag = data.subarray(ciphertextEnd, ciphertextEnd + TAG_BYTES);
  offset = ciphertextEnd + TAG_BYTES;
  const dekNonce = data.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const wrappedCt = data.subarray(offset, offset + DEK_BYTES);
  const wrappedTag = data.subarray(offset + DEK_BYTES, offset + DEK_BYTES + TAG_BYTES);

  let dek: Buffer;
  let zip: Buffer;
  try {
    dek = gcmOpen(kek, dekNonce, wrappedCt, wrappedTag);
    zip = gcmOpen(dek, contentNonce, contentCiphertext, contentTag);
  } catch {
    throw new Error("配置包解密失败（内容被篡改或密钥不匹配）");
  }
  const fingerprint = createHash("sha256").update(data).digest("hex");
  return { zip, keyId: header.keyId, fingerprint, header };
}
