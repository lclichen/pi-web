import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * apkg 密钥仓（发布方打包与导入侧共用的 KEK 存储）。
 *
 * 格式：<dataDir>/apkg-keys.json = Record<keyId, base64(32 字节 KEK)>，
 * 文件权限 0600。发布方用它打包（scripts/pack-apkg.ts、/api/apkg/pack），
 * 每台需要导入该包的 pi-web 服务器都要部署同一份仓文件。
 *
 * 这里只做存取与代际管理，信封格式逻辑在 lib/apkg-format.ts。
 * 从 pack-apkg.ts 内联实现抽出，CLI 与打包 API 共用同一套语义。
 */

export const APKG_KEY_ID_MAX_BYTES = 16;

export function apkgKeysStorePath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const dataDir = process.env.PI_WEB_DATA_DIR ?? resolve("data");
  return resolve(dataDir, "apkg-keys.json");
}

export function loadApkgKeyStore(storePath: string): Record<string, string> {
  if (!existsSync(storePath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(storePath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`apkg 密钥仓格式异常（应为 {keyId: base64}）: ${storePath}`);
  }
  return parsed as Record<string, string>;
}

function saveApkgKeyStore(storePath: string, store: Record<string, string>): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** 列出可用密钥代（仅 id —— 密钥材料永不离开服务端）。 */
export function listApkgKeyIds(storePath: string): string[] {
  return Object.keys(loadApkgKeyStore(storePath)).sort();
}

export function validateApkgKeyId(keyId: string): void {
  if (keyId.length === 0 || keyId.length > APKG_KEY_ID_MAX_BYTES) {
    throw new Error(`密钥代 id 长度须为 1..${APKG_KEY_ID_MAX_BYTES} 字节: ${keyId}`);
  }
}

function decodeKek(b64: string): Buffer {
  const kek = Buffer.from(b64, "base64");
  if (kek.length !== 32) throw new Error("密钥长度异常（应为 32 字节），请检查密钥仓或重新生成");
  return kek;
}

/** 读取指定代（不存在返回 undefined，绝不顺手创建）。 */
export function getApkgKek(storePath: string, keyId: string): { keyId: string; kek: Buffer } | undefined {
  const b64 = loadApkgKeyStore(storePath)[keyId];
  if (!b64) return undefined;
  return { keyId, kek: decodeKek(b64) };
}

/** 新建密钥代并持久化；返回可直接用于 packApkg 的材料。 */
export function createApkgKeyGeneration(storePath: string, keyId?: string): { keyId: string; kek: Buffer; isNew: true } {
  const store = loadApkgKeyStore(storePath);
  const id = keyId ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(2).toString("hex")}`;
  validateApkgKeyId(id);
  if (store[id]) throw new Error(`密钥代 id 已存在: ${id}`);
  const kek = randomBytes(32);
  store[id] = kek.toString("base64");
  saveApkgKeyStore(storePath, store);
  return { keyId: id, kek, isNew: true };
}

/**
 * pack 语义的取钥：指定代存在即用；不存在（或仓为空）则新建一代并持久化。
 * 与原 CLI loadOrCreateKek 行为一致——首次打包零配置可用，代价是必须把
 * 新仓文件部署到全部导入侧。
 */
export function getOrCreateApkgKek(storePath: string, keyId?: string): { keyId: string; kek: Buffer; isNew: boolean } {
  if (keyId) {
    validateApkgKeyId(keyId);
    const existing = getApkgKek(storePath, keyId);
    if (existing) return { ...existing, isNew: false };
  }
  const created = createApkgKeyGeneration(storePath, keyId);
  return { keyId: created.keyId, kek: created.kek, isNew: true };
}
