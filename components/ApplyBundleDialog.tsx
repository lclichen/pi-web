"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 套用配置模板 — pick one of the admin-managed preset bundles and apply it
 * to an existing project (POST /api/projects/:id/apply-bundle). Additive:
 * same-named files overwrite, everything else is kept.
 */
export function ApplyBundleDialog({ projectId, projectName, onClose, onApplied }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useI18n();
  const [bundles, setBundles] = useState<Array<{ name: string; description: string; size: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/bundles")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { bundles?: Array<{ name: string; description: string; size: number }> }) => {
        setBundles(d.bundles ?? []);
      })
      .catch(() => setError(t("加载模板列表失败")))
      .finally(() => setLoading(false));
  }, [t]);

  const apply = async () => {
    if (!selected) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/apply-bundle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selected }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDone(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const btnStyle: React.CSSProperties = {
    height: 30, padding: "0 14px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, cursor: "pointer",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 18, width: "min(440px, calc(100vw - 32px))", boxShadow: "0 12px 36px rgba(0,0,0,0.2)" }}>
        {done ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("已套用模板「{name}」", { name: done })}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
              {t("同名文件已覆盖，其余保留。项目下次会话生效（扩展需重新加载）。")}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={{ ...btnStyle, borderColor: "rgba(37,99,235,0.35)", color: "var(--accent)" }} onClick={() => { onApplied(); onClose(); }}>{t("完成")}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t("套用配置模板")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12 }}>{projectName}</div>
            {loading ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 0" }}>{t("加载模板…")}</div>
            ) : bundles.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 0", lineHeight: 1.6 }}>
                {t("暂无可用模板。管理员可在 设置 → 配置模板 上传。")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12, maxHeight: 240, overflowY: "auto" }}>
                {bundles.map((b) => (
                  <button
                    key={b.name}
                    type="button"
                    onClick={() => setSelected(b.name)}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                      padding: "7px 10px", border: `1px solid ${selected === b.name ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 7, background: selected === b.name ? "rgba(37,99,235,0.07)" : "transparent",
                      color: "var(--text)", fontSize: 12, cursor: "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{b.name}</span>
                    {b.description && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{b.description}</span>}
                  </button>
                ))}
              </div>
            )}
            {error && <div style={{ color: "#f87171", fontSize: 11, marginBottom: 8 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" style={btnStyle} onClick={onClose}>{t("取消")}</button>
              <button
                type="button"
                disabled={!selected || applying}
                onClick={() => void apply()}
                style={{ ...btnStyle, borderColor: "rgba(37,99,235,0.35)", color: "var(--accent)", fontWeight: 600, opacity: !selected || applying ? 0.5 : 1 }}
              >
                {applying ? t("套用中…") : t("套用")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
