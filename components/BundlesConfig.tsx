"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigField,
  ConfigPanelShell,
} from "./SettingsUi";

/**
 * 配置模板管理（设置面板，仅管理员）— preset config bundles for projects.
 * 上传（multipart zip）/ 删除（DELETE /api/bundles）；列表所有登录用户可见
 * （新建项目向导的同源数据）。UI 走共享 Config* 组件（与技能/插件页同风格）。
 */

interface BundleMeta {
  name: string;
  description: string;
  size: number;
  createdAt: number;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6,
  background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
};
const monoStyle: React.CSSProperties = { ...inputStyle, fontFamily: "var(--font-mono)" };

export function BundlesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [bundles, setBundles] = useState<BundleMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bundles");
      const data = (await res.json()) as { bundles?: BundleMeta[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBundles(data.bundles ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError(t("请选择一个 zip 文件"));
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (name.trim()) form.set("name", name.trim());
      if (description.trim()) form.set("description", description.trim());
      const res = await fetch("/api/bundles", { method: "POST", body: form });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setName("");
      setDescription("");
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (bundle: BundleMeta) => {
    if (!window.confirm(t("确定删除模板「{name}」吗？已套用它的项目不受影响。", { name: bundle.name }))) return;
    try {
      const res = await fetch(`/api/bundles?name=${encodeURIComponent(bundle.name)}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("配置模板")} onClose={() => {}}>
      <ConfigDetailStack className="is-fill">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ConfigDetailTitle>{t("配置模板")}</ConfigDetailTitle>
            <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
              {t("配置模板是管理员维护的标准 .pi/ 配置 + labs/ 打包（zip）。用户新建项目时可在向导中选择；已有项目可通过项目菜单「套用配置模板…」补装。")}
            </span>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            <ConfigButton variant="primary" onClick={() => void upload()} disabled={uploading}>
              {uploading ? t("上传中…") : t("上传")}
            </ConfigButton>
          </ConfigDetailActions>
        </ConfigDetailHeader>

        {error && (
          <div role="alert" style={{ color: "#f87171", fontSize: 12, padding: "6px 10px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>{t("加载配置模板…")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {bundles.map((b) => (
              <div key={b.name} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{b.name}</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{Math.round(b.size / 1024)} KB</span>
                  <div style={{ flex: 1 }} />
                  <ConfigButton size="small" variant="danger" onClick={() => void remove(b)}>{t("删除")}</ConfigButton>
                </div>
                {b.description && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{b.description}</div>}
              </div>
            ))}
            {bundles.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 2px" }}>{t("暂无模板。用下方表单上传第一个。")}</div>
            )}
          </div>
        )}

        <div style={{ border: "1px solid rgba(37,99,235,0.35)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{t("上传新模板")}</div>
          <input ref={fileRef} type="file" accept=".zip" style={{ fontSize: 11 }} />
          <ConfigField label={t("模板名（可选，默认用文件名；字母数字点下划线连字符）")}>
            <input value={name} onChange={(e) => setName(e.target.value)} style={monoStyle} maxLength={64} placeholder="standard-lab" />
          </ConfigField>
          <ConfigField label={t("描述（可选）")}>
            <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} maxLength={200} />
          </ConfigField>
          {uploadError && <div role="alert" style={{ color: "#f87171", fontSize: 11 }}>{uploadError}</div>}
        </div>
      </ConfigDetailStack>
    </ConfigPanelShell>
  );
}
