"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "./use-confirm";
import { ConfigButton, ConfigEmptyState, ConfigInfoTip } from "./SettingsUi";
import type { EmbedProductProfile } from "@/lib/embed-types";

interface Props {
  isAdmin?: boolean;
}

interface BundleOption {
  name: string;
  version?: string;
}

interface UserOption {
  id: number;
  username: string;
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

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Settings → Embed (admin): product user groups, fixed Agent bundle, default
 * project mode, command/origin policy. End users authenticate in the embed
 * page with their API key; there are no token links to manage here.
 */
export function EmbedConfig({ isAdmin = false }: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [products, setProducts] = useState<EmbedProductProfile[]>([]);
  const [bundles, setBundles] = useState<BundleOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memberPicker, setMemberPicker] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberResults, setMemberResults] = useState<UserOption[]>([]);

  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [profileRes, bundleRes, userRes] = await Promise.all([
        fetch("/api/admin/embed-profiles", { cache: "no-store" }),
        fetch("/api/bundles", { cache: "no-store" }),
        fetch("/api/admin/users?limit=200&offset=0", { cache: "no-store" }),
      ]);
      const profileData = (await profileRes.json().catch(() => ({}))) as {
        products?: EmbedProductProfile[];
        error?: string;
      };
      if (!profileRes.ok) throw new Error(profileData.error ?? `HTTP ${profileRes.status}`);
      setProducts(profileData.products ?? []);
      if (bundleRes.ok) {
        const data = (await bundleRes.json().catch(() => ({}))) as { bundles?: BundleOption[] };
        setBundles(data.bundles ?? []);
      }
      if (userRes.ok) {
        const data = (await userRes.json().catch(() => ({}))) as { users?: UserOption[] };
        setUsers(data.users ?? []);
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

  useEffect(() => {
    if (memberPicker === null || !memberQuery.trim()) {
      setMemberResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/admin/users?search=${encodeURIComponent(memberQuery.trim())}&limit=8`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = (await response.json().catch(() => ({}))) as { users?: UserOption[] };
          if (response.ok) setMemberResults(data.users ?? []);
        })
        .catch(() => {});
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [memberPicker, memberQuery]);

  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  const updateProduct = useCallback((index: number, patch: Partial<EmbedProductProfile>) => {
    setProducts((current) => current.map((product, i) => (i === index ? { ...product, ...patch } : product)));
  }, []);

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
        members: [],
        configBundle: null,
        defaultMode: "local-machine",
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

  const addMember = useCallback(
    (productIndex: number, user: UserOption) => {
      const product = products[productIndex];
      if (!product) return;
      const members = product.members ?? [];
      if (members.includes(user.id)) return;
      updateProduct(productIndex, { members: [...members, user.id] });
      setMemberQuery("");
      setMemberResults([]);
      setMemberPicker(null);
      if (!userNames.has(user.id)) setUsers((current) => [...current, user]);
    },
    [products, updateProduct, userNames],
  );

  if (!isAdmin) {
    return (
      <div style={{ padding: 18 }}>
        <ConfigEmptyState>{t("embed.adminOnly")}</ConfigEmptyState>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "18px 22px",
        maxWidth: 980,
        height: "100%",
        maxHeight: "100%",
        boxSizing: "border-box",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 700 }}>
        {t("embed.settingsTitle")}
        <ConfigInfoTip text={t("embed.settingsHint")} />
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger, #ef4444)" }}>
          {error}
        </div>
      )}
      {notice && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{notice}</div>}

      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <strong style={{ flex: 1, fontSize: 13 }}>{t("embed.products")}</strong>
          <ConfigButton size="small" onClick={addProduct}>
            {t("embed.addProduct")}
          </ConfigButton>
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("embed.loading")}</div>
        ) : products.length === 0 ? (
          <ConfigEmptyState>{t("embed.noProducts")}</ConfigEmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {products.map((product, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: 10,
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg)",
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "minmax(90px, 0.7fr) minmax(120px, 1fr) auto", gap: 8 }}>
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
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(160px, 1fr)", gap: 8 }}>
                  <input
                    value={product.allowedCommands.join(", ")}
                    aria-label={t("embed.allowedCommands")}
                    placeholder={t("embed.allowedCommandsPlaceholder")}
                    onChange={(event) => updateProduct(index, { allowedCommands: parseList(event.target.value) })}
                    style={fieldStyle}
                  />
                  <input
                    value={product.allowedOrigins.join(", ")}
                    aria-label={t("embed.allowedOrigins")}
                    placeholder={t("embed.allowedOriginsPlaceholder")}
                    onChange={(event) => updateProduct(index, { allowedOrigins: parseList(event.target.value) })}
                    style={fieldStyle}
                  />
                  <select
                    value={product.defaultMode ?? "local-machine"}
                    aria-label={t("embed.defaultMode")}
                    onChange={(event) =>
                      updateProduct(index, { defaultMode: event.target.value as EmbedProductProfile["defaultMode"] })
                    }
                    style={fieldStyle}
                  >
                    <option value="local-machine">local-machine</option>
                    <option value="sandbox">sandbox</option>
                    <option value="ssh">ssh</option>
                  </select>
                  <select
                    value={product.configBundle ?? ""}
                    aria-label={t("embed.configBundle")}
                    onChange={(event) => updateProduct(index, { configBundle: event.target.value || null })}
                    style={fieldStyle}
                  >
                    <option value="">{t("embed.noBundle")}</option>
                    {bundles.map((bundle) => (
                      <option key={bundle.name} value={bundle.name}>
                        {bundle.name}
                        {bundle.version ? ` (${bundle.version})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ color: "var(--text-muted)" }}>{t("embed.members")}:</span>
                  {product.members === undefined ? (
                    <span style={{ color: "var(--text-dim)" }}>{t("embed.allUsers")}</span>
                  ) : product.members.length === 0 ? (
                    <span style={{ color: "var(--text-dim)" }}>{t("embed.noMembers")}</span>
                  ) : (
                    product.members.map((memberId) => (
                      <span
                        key={memberId}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 6px",
                          borderRadius: 999,
                          border: "1px solid var(--border)",
                          color: "var(--text-muted)",
                        }}
                      >
                        {userNames.get(memberId) ?? `#${memberId}`}
                        <button
                          type="button"
                          aria-label={t("embed.removeMember")}
                          onClick={() =>
                            updateProduct(index, {
                              members: (product.members ?? []).filter((id) => id !== memberId),
                            })
                          }
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--text-dim)",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (product.members === undefined) updateProduct(index, { members: [] });
                      setMemberPicker(memberPicker === index ? null : index);
                      setMemberQuery("");
                      setMemberResults([]);
                    }}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 999,
                      background: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      padding: "2px 8px",
                    }}
                  >
                    + {t("embed.addMember")}
                  </button>
                </div>

                {memberPicker === index && (
                  <div style={{ position: "relative", maxWidth: 320 }}>
                    <input
                      autoFocus
                      value={memberQuery}
                      onChange={(event) => setMemberQuery(event.target.value)}
                      placeholder={t("embed.memberSearch")}
                      style={{ ...fieldStyle, width: "100%" }}
                    />
                    {memberResults.length > 0 && (
                      <div
                        style={{
                          position: "absolute",
                          top: "100%",
                          left: 0,
                          right: 0,
                          zIndex: 20,
                          marginTop: 4,
                          maxHeight: 220,
                          overflowY: "auto",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "var(--bg-panel)",
                          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                        }}
                      >
                        {memberResults.map((user) => (
                          <button
                            key={user.id}
                            type="button"
                            onClick={() => addMember(index, user)}
                            style={{
                              width: "100%",
                              padding: "6px 8px",
                              border: "none",
                              background: "transparent",
                              color: "var(--text)",
                              textAlign: "left",
                              cursor: "pointer",
                              fontSize: 12,
                            }}
                          >
                            {user.username}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
      {confirmDialog}
    </div>
  );
}
