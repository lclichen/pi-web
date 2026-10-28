"use client";

/**
 * 设置 → API 密钥：平台个人密钥的自服务管理（创建/回显/复制/吊销）。
 *
 * 密钥的事实源在沙盒平台（/api/v1/auth/api-keys，按用户隔离、长效不过期）；
 * 明文的可重复回显由 pi-web 侧保管文件支撑（lib/api-key-vault.ts）——
 * 经此处创建的密钥可随时查看与复制，平台侧直建的密钥只显示前缀。
 * 批量测试接口（/api/batch/tasks）对所有用户开放（每用户并发限额），
 * 经请求头 X-Platform-API-Key 认证。
 *
 * 外壳与"常规/用户"页同款（settings-general 样式族，app/settings.css）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import { useConfirm } from "./use-confirm";

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
  /** manual=经此页创建；auto=登录会话密钥（每次登录铸一个，随会话吊销）；external=平台侧直建。 */
  source?: "manual" | "auto" | "external";
  /** 当前浏览器会话正在使用的密钥（吊销 = 立即下线本会话）。 */
  isCurrent?: boolean;
}

type KeySource = "manual" | "auto" | "external";

function groupOf(row: ApiKeyRow): KeySource {
  return row.source ?? (row.canReveal ? "manual" : "external");
}

export function ApiKeysConfig() {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
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
  /** 登录会话密钥组默认折叠——它们是系统凭证，通常无需关注。 */
  const [autoExpanded, setAutoExpanded] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealNewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (revealNewTimer.current) clearTimeout(revealNewTimer.current);
    };
  }, []);

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
      // "已创建"提示与自动展开只保留一小段时间；之后揭示状态完全由
      // revealed 集合驱动，隐藏按钮才能立即生效。
      if (revealNewTimer.current) clearTimeout(revealNewTimer.current);
      revealNewTimer.current = setTimeout(() => setRevealNew(null), 8000);
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
    // 同时清掉 revealNew：否则刚创建的密钥点"隐藏"不会收起。
    setRevealNew((current) => (current === id ? null : current));
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const revoke = useCallback(
    async (row: ApiKeyRow) => {
      if (revoking !== null) return;
      const ok = await confirm({
        title: t("apiKeys.revoke"),
        message: t("apiKeys.revokeConfirm", { name: row.name }),
        confirmLabel: t("apiKeys.revoke"),
        abortLabel: t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
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
    },
    [revoking, t, confirm],
  );

  const fmtDate = (iso: string | null): string => {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const renderKeyRow = (row: ApiKeyRow, opts: { notRevealableBadge: boolean }) => {
    const isRevealed = revealed.has(row.id);
    return (
      <div key={row.id} className="api-key-row">
        <div className="api-key-row-main">
          <div className="api-key-row-ident">
            <div className="api-key-name">
              {row.name}
              {row.isCurrent && <span className="api-key-current-tag">{t("apiKeys.currentSession")}</span>}
            </div>
            <div className="api-key-meta">
              {row.keyPrefix ?? ""}
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
            opts.notRevealableBadge && (
              <span className="api-key-not-revealable" title={t("apiKeys.notRevealable")}>
                {t("apiKeys.notRevealableShort")}
              </span>
            )
          )}
          <ConfigButton variant="danger" size="small" disabled={revoking !== null} onClick={() => void revoke(row)}>
            {revoking === row.id ? t("apiKeys.revoking") : t("apiKeys.revoke")}
          </ConfigButton>
        </div>
        {row.canReveal && isRevealed && row.key && (
          <div className="api-key-secret-box">
            <code className="api-key-secret">{row.key}</code>
            <ConfigButton size="small" onClick={() => void copyKey(row)}>
              {copied === row.id ? t("apiKeys.copied") : t("apiKeys.copy")}
            </ConfigButton>
          </div>
        )}
      </div>
    );
  };

  const manualKeys = keys.filter((row) => groupOf(row) === "manual");
  const autoKeys = keys.filter((row) => groupOf(row) === "auto");
  const externalKeys = keys.filter((row) => groupOf(row) === "external");

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.apiKeys")}</h2>
      {loadError ? (
        <p role="alert" className="settings-general-error">
          {loadError}
        </p>
      ) : (
        <>
          <section className="settings-general-section">
            <p className="settings-general-description">
              {t("apiKeys.desc")}
              <br />
              {t("apiKeys.batchAdminNote")}
            </p>
            <form
              className="api-keys-create-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                className="config-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeys.namePlaceholder")}
                maxLength={128}
              />
              <ConfigButton variant="primary" onClick={() => void create()} disabled={creating || !name.trim()}>
                {creating ? t("apiKeys.creating") : t("apiKeys.create")}
              </ConfigButton>
            </form>
            {createError && (
              <p role="alert" className="settings-general-error">
                {createError}
              </p>
            )}
            {revealNew !== null && <p className="api-key-created-hint">{t("apiKeys.createdHint")}</p>}
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("apiKeys.listHeading")}</h3>
            {loading ? (
              <p className="settings-general-description">{t("apiKeys.loading")}</p>
            ) : keys.length === 0 ? (
              <p className="settings-general-description">{t("apiKeys.empty")}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {manualKeys.length > 0 && (
                  <>
                    <div className="api-key-group-heading">{t("apiKeys.groupManual")}</div>
                    {manualKeys.map((row) => renderKeyRow(row, { notRevealableBadge: false }))}
                  </>
                )}

                {autoKeys.length > 0 && (
                  <div className="api-key-group">
                    <button
                      type="button"
                      className="api-key-group-toggle"
                      aria-expanded={autoExpanded}
                      onClick={() => setAutoExpanded((v) => !v)}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={{
                          transform: autoExpanded ? "rotate(90deg)" : "none",
                          transition: "transform 0.12s",
                          flexShrink: 0,
                        }}
                      >
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                      <span>
                        {t("apiKeys.groupAuto")}（{autoKeys.length}）
                      </span>
                    </button>
                    <p className="settings-general-description" style={{ marginBottom: 0 }}>
                      {t("apiKeys.groupAutoDesc")}
                    </p>
                    {autoExpanded && autoKeys.map((row) => renderKeyRow(row, { notRevealableBadge: false }))}
                  </div>
                )}

                {externalKeys.length > 0 && (
                  <>
                    <div className="api-key-group-heading">{t("apiKeys.groupExternal")}</div>
                    {externalKeys.map((row) => renderKeyRow(row, { notRevealableBadge: true }))}
                  </>
                )}
              </div>
            )}
            {revokeError && (
              <p role="alert" className="settings-general-error">
                {revokeError}
              </p>
            )}
          </section>
        </>
      )}
      {confirmDialog}
    </div>
  );
}
