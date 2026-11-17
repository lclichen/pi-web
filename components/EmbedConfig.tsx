"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "./use-confirm";
import { ConfigButton, ConfigEmptyState, ConfigInfoTip } from "./SettingsUi";
import type { EmbedProductProfile, EmbedTokenView } from "@/lib/embed-types";

interface Props {
  isAdmin?: boolean;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const fieldStyle: React.CSSProperties = {
  height: 30,
  minWidth: 0,
  padding: "0 8px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
};

function formatDate(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/**
 * Settings → Embed: every user manages their own links; admins additionally
 * maintain product profiles (command allowlist + parent-origin allowlist).
 */
export function EmbedConfig({ isAdmin = false }: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [tokens, setTokens] = useState<EmbedTokenView[]>([]);
  const [products, setProducts] = useState<EmbedProductProfile[]>([]);
  const [productsEnabled, setProductsEnabled] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tokenRes, enabledRes, profileRes] = await Promise.all([
        fetch("/api/embed/tokens", { cache: "no-store" }),
        fetch("/api/embed/products", { cache: "no-store" }),
        isAdmin ? fetch("/api/admin/embed-profiles", { cache: "no-store" }) : Promise.resolve(null),
      ]);
      const tokenData = (await tokenRes.json().catch(() => ({}))) as { tokens?: EmbedTokenView[]; error?: string };
      if (!tokenRes.ok) throw new Error(tokenData.error ?? `HTTP ${tokenRes.status}`);
      setTokens(tokenData.tokens ?? []);

      const enabledData = (await enabledRes.json().catch(() => ({}))) as {
        products?: { id: string; name: string }[];
      };
      if (enabledRes.ok) setProductsEnabled(enabledData.products ?? []);

      if (profileRes) {
        const profileData = (await profileRes.json().catch(() => ({}))) as {
          products?: EmbedProductProfile[];
          error?: string;
        };
        if (!profileRes.ok) throw new Error(profileData.error ?? `HTTP ${profileRes.status}`);
        setProducts(profileData.products ?? []);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const productNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const product of productsEnabled) map.set(product.id, product.name);
    for (const product of products) map.set(product.id, product.name);
    return map;
  }, [products, productsEnabled]);

  const saveProducts = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/embed-profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        products?: EmbedProductProfile[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProducts(data.products ?? []);
      setNotice(t("embed.saved"));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [load, products, t]);

  const addProduct = useCallback(() => {
    setProducts((current) => [
      ...current,
      {
        id: `product-${current.length + 1}`,
        name: "",
        allowedCommands: [],
        allowedOrigins: [],
        enabled: true,
      },
    ]);
  }, []);

  const removeProduct = useCallback(
    async (index: number) => {
      const product = products[index];
      if (!product) return;
      const ok = await confirm({
        title: t("embed.deleteProduct"),
        message: t("embed.deleteProductConfirm", { name: product.name || product.id }),
        confirmLabel: t("common.delete"),
        abortLabel: t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
      setProducts((current) => current.filter((_, i) => i !== index));
    },
    [confirm, products, t],
  );

  const revoke = useCallback(
    async (token: EmbedTokenView) => {
      const ok = await confirm({
        title: t("embed.revoke"),
        message: t("embed.revokeConfirm", { name: token.label }),
        confirmLabel: t("embed.revoke"),
        abortLabel: t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(`/api/embed/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setTokens((current) => current.filter((item) => item.id !== token.id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [confirm, t],
  );

  const updateProduct = useCallback((index: number, patch: Partial<EmbedProductProfile>) => {
    setProducts((current) => current.map((product, i) => (i === index ? { ...product, ...patch } : product)));
  }, []);

  const parseList = (value: string): string[] =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "18px 22px",
        maxWidth: 900,
        height: "100%",
        maxHeight: "100%",
        boxSizing: "border-box",
        overflowY: "auto",
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 700 }}>
          {t("embed.settingsTitle")}
          <ConfigInfoTip text={t("embed.settingsHint")} />
        </div>
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger, #ef4444)" }}>
          {error}
        </div>
      )}
      {notice && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{notice}</div>}

      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <strong style={{ flex: 1, fontSize: 13 }}>{t("embed.tokens")}</strong>
          <ConfigInfoTip text={t("embed.tokensHint")} />
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("embed.loading")}</div>
        ) : tokens.length === 0 ? (
          <ConfigEmptyState>{t("embed.noTokens")}</ConfigEmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tokens.map((token) => (
              <div
                key={token.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 0,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {token.label}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2, fontSize: 10, color: "var(--text-dim)" }}>
                    <span>{productNames.get(token.productId) ?? token.productId}</span>
                    <span>{isAdmin ? `${token.ownerName} · ` : ""}{formatDate(token.expiresAt)}</span>
                  </div>
                </div>
                <ConfigButton variant="danger" size="small" onClick={() => void revoke(token)}>
                  {t("embed.revoke")}
                </ConfigButton>
              </div>
            ))}
          </div>
        )}
      </section>

      {isAdmin && (
        <section style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <strong style={{ flex: 1, fontSize: 13 }}>{t("embed.products")}</strong>
            <ConfigInfoTip text={t("embed.commandsHint")} />
            <ConfigButton size="small" onClick={addProduct}>
              {t("embed.addProduct")}
            </ConfigButton>
          </div>
          {products.length === 0 ? (
            <ConfigEmptyState>{t("embed.noProducts")}</ConfigEmptyState>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {products.map((product, index) => (
                <div
                  key={index}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(90px, 0.7fr) minmax(120px, 1fr) auto",
                    gap: 8,
                    alignItems: "center",
                    padding: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    background: "var(--bg)",
                  }}
                >
                  <input
                    value={product.id}
                    aria-label={t("embed.productId")}
                    placeholder={t("embed.productId")}
                    onChange={(event) => updateProduct(index, { id: event.target.value })}
                    style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
                  />
                  <input
                    value={product.name}
                    aria-label={t("embed.productName")}
                    placeholder={t("embed.productName")}
                    onChange={(event) => updateProduct(index, { name: event.target.value })}
                    style={fieldStyle}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
                      <input
                        type="checkbox"
                        checked={product.enabled}
                        onChange={(event) => updateProduct(index, { enabled: event.target.checked })}
                      />
                      {t("embed.enabled")}
                    </label>
                    <ConfigButton variant="danger" size="small" onClick={() => void removeProduct(index)}>
                      {t("common.delete")}
                    </ConfigButton>
                  </div>
                  <input
                    value={product.allowedCommands.join(", ")}
                    aria-label={t("embed.allowedCommands")}
                    placeholder={t("embed.allowedCommandsPlaceholder")}
                    onChange={(event) => updateProduct(index, { allowedCommands: parseList(event.target.value) })}
                    style={{ ...fieldStyle, gridColumn: "1 / 3" }}
                  />
                  <input
                    value={product.allowedOrigins.join(", ")}
                    aria-label={t("embed.allowedOrigins")}
                    placeholder={t("embed.allowedOriginsPlaceholder")}
                    onChange={(event) => updateProduct(index, { allowedOrigins: parseList(event.target.value) })}
                    style={{ ...fieldStyle, gridColumn: "1 / 4" }}
                  />
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <ConfigButton variant="primary" disabled={saving} onClick={() => void saveProducts()}>
              {saving ? t("embed.saving") : t("embed.saveProducts")}
            </ConfigButton>
          </div>
        </section>
      )}
      {confirmDialog}
    </div>
  );
}
