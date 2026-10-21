"use client";

/**
 * 设置 → API 密钥：平台个人密钥的自服务管理（创建/回显/复制/吊销）。
 *
 * 密钥的事实源在沙盒平台（/api/v1/auth/api-keys，按用户隔离、长效不过期）；
 * 明文的可重复回显由 pi-web 侧保管文件支撑（lib/api-key-vault.ts）——
 * 经此处创建的密钥可随时查看与复制，平台侧直建的密钥只显示前缀。
 * 批量测试接口（/api/batch/tasks）要求管理员密钥，非管理员创建的密钥
 * 可用于其他 X-Platform-API-Key 场景。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetailStack,
  ConfigDetailTitle,
} from "./SettingsUi";

interface ApiKeyRow {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** 仅经 pi-web 创建（保管在册）的密钥返回。 */
  key?: string;
  canReveal: boolean;
}

interface Props {
  embedded?: boolean;
  onClose?: () => void;
}

export function ApiKeysConfig({ embedded = false, onClose }: Props) {
  const { t } = useI18n();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** 新建后自动展开明文一次（用户要求：可重复显示，非一次性）。 */
  const [revealNew, setRevealNew] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/platform/api-keys");
      const d = (await res.json()) as { keys?: ApiKeyRow[]; error?: string };
      if (!res.ok || d.error) {
        setLoadError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setKeys(d.keys ?? []);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [load]);

  const create = useCallback(async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/platform/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = (await res.json()) as { key?: ApiKeyRow; vaulted?: boolean; error?: string };
      if (!res.ok || d.error || !d.key) {
        setCreateError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setKeys((prev) => [d.key!, ...prev]);
      setName("");
      setRevealNew(d.key.id);
      setRevealed((prev) => new Set(prev).add(d.key!.id));
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }, [name, creating]);

  const copyKey = useCallback(async (row: ApiKeyRow) => {
    if (!row.key) return;
    try {
      await navigator.clipboard.writeText(row.key);
      setCopied(row.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用时退化：保持明文展开，用户手动选择复制
      setRevealed((prev) => new Set(prev).add(row.id));
    }
  }, []);

  const toggleReveal = useCallback((id: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const revoke = useCallback(async (row: ApiKeyRow) => {
    if (revoking !== null) return;
    if (!window.confirm(t("apiKeys.revokeConfirm", { name: row.name }))) return;
    setRevoking(row.id);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/platform/api-keys/${row.id}`, { method: "DELETE" });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || d.error) {
        setRevokeError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== row.id));
    } catch (e) {
      setRevokeError(String(e));
    } finally {
      setRevoking(null);
    }
  }, [revoking, t]);

  const fmtDate = (iso: string | null): string => {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <ConfigDetailStack className="is-full-height">
      <ConfigDetailTitle>{t("settings.apiKeys")}</ConfigDetailTitle>
      <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
        {t("apiKeys.desc")}
        <div style={{ marginTop: 4 }}>{t("apiKeys.batchAdminNote")}</div>
      </div>

      {/* 创建行 */}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          placeholder={t("apiKeys.namePlaceholder")}
          maxLength={128}
          style={{
            flex: 1,
            padding: "7px 10px",
            fontSize: 12,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            outline: "none",
          }}
        />
        <ConfigButton variant="primary" onClick={() => void create()} disabled={creating || !name.trim()}>
          {creating ? t("apiKeys.creating") : t("apiKeys.create")}
        </ConfigButton>
      </div>
      {createError && <div style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}>{createError}</div>}
      {revealNew !== null && (
        <div style={{ fontSize: 12, color: "#22c55e" }}>{t("apiKeys.createdHint")}</div>
      )}

      {/* 列表 */}
      {loading ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("apiKeys.loading")}</div>
      ) : loadError ? (
        <div style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}>{loadError}</div>
      ) : keys.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("apiKeys.empty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
          {keys.map((row) => {
            const isRevealed = revealed.has(row.id) || revealNew === row.id;
            return (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "10px 0",
                  borderBottom: "1px solid var(--border)",
                  opacity: row.revokedAt ? 0.55 : 1,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{row.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                      {row.keyPrefix ?? ""}
                      {row.revokedAt ? ` · ${t("apiKeys.revoked")}` : ""}
                      {` · ${t("apiKeys.created")} ${fmtDate(row.createdAt)}`}
                      {row.lastUsedAt ? ` · ${t("apiKeys.lastUsed")} ${fmtDate(row.lastUsedAt)}` : ""}
                    </div>
                  </div>
                  {row.canReveal ? (
                    <>
                      <ConfigButton size="small" onClick={() => toggleReveal(row.id)}>
                        {isRevealed ? t("apiKeys.hide") : t("apiKeys.show")}
                      </ConfigButton>
                      <ConfigButton size="small" onClick={() => void copyKey(row)} disabled={!row.key}>
                        {copied === row.id ? t("apiKeys.copied") : t("apiKeys.copy")}
                      </ConfigButton>
                    </>
                  ) : (
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)" }} title={t("apiKeys.notRevealable")}>
                      {t("apiKeys.notRevealableShort")}
                    </span>
                  )}
                  <ConfigButton
                    size="small"
                    disabled={Boolean(row.revokedAt) || revoking !== null}
                    onClick={() => void revoke(row)}
                    style={{ color: "#f87171" }}
                  >
                    {revoking === row.id ? t("apiKeys.revoking") : t("apiKeys.revoke")}
                  </ConfigButton>
                </div>
                {row.canReveal && isRevealed && row.key && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                    }}
                  >
                    <code style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", wordBreak: "break-all" }}>
                      {row.key}
                    </code>
                    <ConfigButton size="small" onClick={() => void copyKey(row)}>
                      {copied === row.id ? t("apiKeys.copied") : t("apiKeys.copy")}
                    </ConfigButton>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {revokeError && <div style={{ fontSize: 12, color: "#f87171" }}>{revokeError}</div>}

      {!embedded && (
        <div style={{ marginTop: 16 }}>
          <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>
        </div>
      )}
    </ConfigDetailStack>
  );
}
