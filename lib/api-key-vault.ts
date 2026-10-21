/**
 * 平台 API 密钥的明文保管（pi-web 侧）。
 *
 * 平台只存密钥的 sha256 哈希（创建后明文不可恢复），而用户需要"随时回显、
 * 多次复制"。此保管文件保存**经 pi-web UI 创建**的密钥明文，回显/复制由
 * 它支撑；直接在平台侧（curl/其他客户端）创建的密钥不在保管范围内——UI
 * 会标注"无法回显"。
 *
 * 布局：<dataDir>/api-key-vault.json，按用户分桶：{ version, users: { u<id>:
 * { <平台keyId>: { name, key, createdAt } } } }。0600 + 原子写（与 apkg-keys
 * 同规格）。明文落盘是明确的产品取舍（内网教学部署、文件仅服务端可读、
 * 仅本人会话可读回）；若未来要求更高，可换成用部署密钥加密后存。
 */
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { dataDir } from "./mode-homes";
import { writePrivateFileAtomicSync } from "./atomic-file";

interface VaultEntry {
  name: string;
  /** 平台密钥明文（sk_...）。 */
  key: string;
  createdAt: string;
}

interface VaultFile {
  version: 1;
  users: Record<string, Record<string, VaultEntry>>;
}

function vaultPath(): string {
  return join(dataDir(), "api-key-vault.json");
}

function readVault(): VaultFile {
  try {
    const parsed = JSON.parse(readFileSync(vaultPath(), "utf8")) as Partial<VaultFile>;
    if (parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object") {
      return { version: 1, users: parsed.users };
    }
  } catch {
    // 不存在或损坏——按空保管处理
  }
  return { version: 1, users: {} };
}

function writeVault(vault: VaultFile): void {
  mkdirSync(dataDir(), { recursive: true });
  writePrivateFileAtomicSync(vaultPath(), JSON.stringify(vault, null, 2));
}

/** 记录（创建密钥后调用）：platform keyId → 明文入保管。 */
export function vaultStoreApiKey(userId: number, keyId: number | string, name: string, plaintext: string): void {
  const vault = readVault();
  const bucket = vault.users[`u${userId}`] ?? {};
  bucket[String(keyId)] = { name, key: plaintext, createdAt: new Date().toISOString() };
  vault.users[`u${userId}`] = bucket;
  writeVault(vault);
}

/** 回显：该用户名下的密钥明文；不在保管（平台侧直建/已吊销清理）返回 null。 */
export function vaultLookupApiKey(userId: number, keyId: number | string): string | null {
  const entry = readVault().users[`u${userId}`]?.[String(keyId)];
  return entry?.key ?? null;
}

/** 该用户全部保管的 keyId → 明文（列表 join 用）。 */
export function vaultListApiKeys(userId: number): Map<string, string> {
  const bucket = readVault().users[`u${userId}`] ?? {};
  return new Map(Object.entries(bucket).map(([id, e]) => [id, e.key]));
}

/** 吊销/清理：移除保管条目（不存在时静默）。 */
export function vaultRemoveApiKey(userId: number, keyId: number | string): void {
  const vault = readVault();
  const bucket = vault.users[`u${userId}`];
  if (!bucket || !(String(keyId) in bucket)) return;
  delete bucket[String(keyId)];
  writeVault(vault);
}

/** 供测试确认文件存在（非空校验）。 */
export function vaultExists(): boolean {
  return existsSync(vaultPath());
}
