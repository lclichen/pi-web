/**
 * 平台 API 密钥的明文保管（pi-web 侧）。
 *
 * 平台只存密钥的 sha256 哈希（创建后明文不可恢复），而用户需要"随时回显、
 * 多次复制"。此保管文件保存**经 pi-web UI 创建**的密钥明文，回显/复制由
 * 它支撑；直接在平台侧（curl/其他客户端）创建的密钥不在保管范围内——UI
 * 会标注"无法回显"。
 *
 * 布局：<dataDir>/state/global/api-key-vault.json，按用户分桶：{ schemaVersion, data:
 * { users: { u<id>: { <平台keyId>: { name, key, createdAt } } } } }。0600 + 原子写（与
 * apkg-recipient 同规格）。明文落盘是明确的产品取舍（内网部署、文件仅
 * 服务端可读、仅本人会话可读回）；若未来要求更高，可换成用部署密钥加密后存。
 */
import { existsSync } from "fs";
import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";

interface VaultEntry {
  name: string;
  /** 平台密钥明文（sk_...）。 */
  key: string;
  createdAt: string;
}

interface VaultData {
  users: Record<string, Record<string, VaultEntry>>;
}

const vaultStore = new JsonStore<VaultData>({
  name: "api-key-vault",
  scope: { kind: "global" },
  legacyPaths: () => [legacyDataPath("api-key-vault.json")],
  defaults: () => ({ users: {} }),
  parse: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const users = (value as { users?: unknown }).users;
    if (!users || typeof users !== "object" || Array.isArray(users)) return null;
    return { users: users as Record<string, Record<string, VaultEntry>> };
  },
});

/** 记录（创建密钥后调用）：platform keyId → 明文入保管。 */
export function vaultStoreApiKey(userId: number, keyId: number | string, name: string, plaintext: string): void {
  vaultStore.update((data) => {
    const bucket = data.users[`u${userId}`] ?? {};
    bucket[String(keyId)] = { name, key: plaintext, createdAt: new Date().toISOString() };
    data.users[`u${userId}`] = bucket;
  });
}

/** 回显：该用户名下的密钥明文；不在保管（平台侧直建/已吊销清理）返回 null。 */
export function vaultLookupApiKey(userId: number, keyId: number | string): string | null {
  const entry = vaultStore.read().users[`u${userId}`]?.[String(keyId)];
  return entry?.key ?? null;
}

/** 该用户全部保管的 keyId → 明文（列表 join 用）。 */
export function vaultListApiKeys(userId: number): Map<string, string> {
  const bucket = vaultStore.read().users[`u${userId}`] ?? {};
  return new Map(Object.entries(bucket).map(([id, e]) => [id, e.key]));
}

/** 吊销/清理：移除保管条目（不存在时静默）。 */
export function vaultRemoveApiKey(userId: number, keyId: number | string): void {
  vaultStore.update((data) => {
    const bucket = data.users[`u${userId}`];
    if (!bucket || !(String(keyId) in bucket)) return;
    delete bucket[String(keyId)];
  });
}

/** 供测试确认文件存在（非空校验）。 */
export function vaultExists(): boolean {
  return existsSync(vaultStore.path) || existsSync(legacyDataPath("api-key-vault.json"));
}
