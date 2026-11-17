"use client";

import { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigInfoTip } from "./SettingsUi";

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

interface ProductOption {
  id: string;
  name: string;
}

/**
 * Creates a workspace-scoped embed link for one product. The returned URL
 * contains the only copy of the token, so the dialog keeps it on screen until
 * the user closes it.
 */
export function EmbedTokenDialog({ projectId, projectName, onClose }: Props) {
  const { t } = useI18n();
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productId, setProductId] = useState("");
  const [ttlDays, setTtlDays] = useState(7);
  const [label, setLabel] = useState(projectName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/embed/products", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as {
          products?: ProductOption[];
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setProducts(data.products ?? []);
        setProductId((current) => current || data.products?.[0]?.id || "");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const create = useCallback(async () => {
    if (!productId || busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch("/api/embed/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          productId,
          ttlMinutes: ttlDays * 24 * 60,
          label: label.trim() || projectName,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? `HTTP ${response.status}`);
      setUrl(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, label, productId, projectId, projectName, ttlDays]);

  const copy = useCallback(async () => {
    if (!url) return;
    try {
      await copyText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [url]);

  const fieldStyle: React.CSSProperties = {
    height: 30,
    padding: "0 8px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 12,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("embed.createLinkTitle")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.45)",
      }}
    >
      <div
        style={{
          width: "min(440px, 100%)",
          maxHeight: "calc(100dvh - 32px)",
          overflowY: "auto",
          padding: 16,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-panel)",
          boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <strong style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{t("embed.createLinkTitle")}</strong>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t("i18n.close")}
            title={t("i18n.close")}
            style={{
              width: 26,
              height: 26,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            {t("embed.product")}
            <select
              value={productId}
              disabled={busy || products.length === 0}
              onChange={(event) => setProductId(event.target.value)}
              style={fieldStyle}
            >
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            {t("embed.ttl")}
            <select
              value={ttlDays}
              disabled={busy}
              onChange={(event) => setTtlDays(Number(event.target.value))}
              style={fieldStyle}
            >
              {[1, 7, 30].map((days) => (
                <option key={days} value={days}>
                  {t("embed.ttlDays", { count: days })}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
            {t("embed.label")}
            <input
              value={label}
              disabled={busy}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              style={fieldStyle}
            />
          </label>

          {products.length === 0 && !error && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("embed.noProducts")}</div>
          )}

          {error && (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger, #ef4444)" }}>
              {error}
            </div>
          )}

          {url ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  readOnly
                  value={url}
                  aria-label={t("embed.link")}
                  onFocus={(event) => event.currentTarget.select()}
                  style={{ ...fieldStyle, flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11 }}
                />
                <ConfigButton variant="primary" size="small" onClick={() => void copy()}>
                  {copied ? t("embed.copied") : t("embed.copyLink")}
                </ConfigButton>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }}>
                {t("embed.linkOnce")}
                <ConfigInfoTip text={t("embed.linkCredential")} />
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <ConfigButton onClick={onClose} disabled={busy}>
                {t("common.cancel")}
              </ConfigButton>
              <ConfigButton variant="primary" onClick={() => void create()} disabled={busy || !productId}>
                {busy ? t("embed.creating") : t("embed.create")}
              </ConfigButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
