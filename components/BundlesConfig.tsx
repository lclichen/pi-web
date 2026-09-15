"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "./SettingsUi";

/**
 * 配置模板管理（设置面板，仅管理员）— preset config bundles for projects.
 * 左侧模板列表 + 右侧详情/上传表单；上传（multipart zip）/ 删除（DELETE /api/bundles）。
 * 列表所有登录用户可见（新建项目向导的同源数据）。布局与模型/子代理页同构：
 * 列表在左、上传入口在侧栏左下角、上传按钮固定在右下角。
 */

interface BundleMeta {
  name: string;
  description: string;
  size: number;
  createdAt: number;
}

// 与模型/子代理页同款输入框样式。
const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 30,
  padding: "3px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};
const monoStyle: React.CSSProperties = { ...inputStyle, fontFamily: "var(--font-mono)" };

function formatSize(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function BundlesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [bundles, setBundles] = useState<BundleMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [uploadMode, setUploadMode] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fileChosen, setFileChosen] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const selected = bundles.find((b) => b.name === selectedName) ?? null;

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

  const selectBundle = (bundle: BundleMeta) => {
    setUploadMode(false);
    setSelectedName(bundle.name);
    setFormError(null);
    setFormMsg(null);
  };

  const startUpload = () => {
    setSelectedName(null);
    setUploadMode(true);
    setName("");
    setDescription("");
    setFileChosen(null);
    setFormError(null);
    setFormMsg(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const exitUpload = () => {
    setUploadMode(false);
    setName("");
    setDescription("");
    setFileChosen(null);
    setFormError(null);
    setFormMsg(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setFormError(t("请选择一个 zip 文件"));
      return;
    }
    setUploading(true);
    setFormError(null);
    setFormMsg(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (name.trim()) form.set("name", name.trim());
      if (description.trim()) form.set("description", description.trim());
      const res = await fetch("/api/bundles", { method: "POST", body: form });
      const data = (await res.json()) as { name?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setName("");
      setDescription("");
      setFileChosen(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
      setUploadMode(false);
      if (data.name) setSelectedName(data.name);
      setFormMsg(t("模板已上传。"));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
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
      if (selectedName === bundle.name) setSelectedName(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const showUpload = uploadMode;
  const showDetail = !showUpload && selected !== null;

  return (
    <ConfigPanelShell embedded={embedded} title={t("配置模板")} closeLabel={t("i18n.close")} onClose={() => {}}>
      {/* Body */}
      <ConfigSplitView>
        {/* Left: bundle list（与模型页同构：列表 + 左下角上传） */}
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? <div className="config-sidebar-message">{t("加载配置模板…")}</div>
            : error ? <div className="config-sidebar-message is-error">{error}</div>
            : bundles.length === 0 ? <div className="config-sidebar-message is-empty">{t("暂无模板")}</div>
            : bundles.map((b) => (
              <ConfigSidebarItem key={b.name} active={!showUpload && selectedName === b.name} onClick={() => selectBundle(b)}>
                <ConfigSidebarText className="is-grow" title={b.description}>{b.name}</ConfigSidebarText>
                <ConfigSidebarText className="is-muted">{formatSize(b.size)}</ConfigSidebarText>
              </ConfigSidebarItem>
            ))}
          </ConfigSidebarList>
          {/* 上传入口固定在侧栏左下角（与模型页「添加 Provider」一致） */}
          <ConfigListAction onClick={startUpload} active={showUpload}>{t("上传模板")}</ConfigListAction>
        </ConfigSidebar>

        {/* Right: upload form / bundle detail */}
        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {showUpload ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{t("上传新模板")}</ConfigDetailTitle>
                  </ConfigDetailHeaderInfo>
                </ConfigDetailHeader>
                <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {t("配置模板是管理员维护的标准 .pi/ 配置 + labs/ 打包（zip）。用户新建项目时可在向导中选择；已有项目可通过项目菜单「套用配置模板…」补装。")}
                </span>
                <ConfigField label={t("选择 zip 文件")}>
                  <input ref={fileRef} type="file" accept=".zip" onChange={(e) => setFileChosen(e.target.files?.[0]?.name ?? null)} style={{ fontSize: 11, color: "var(--text-muted)" }} />
                  {fileChosen && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{fileChosen}</span>}
                </ConfigField>
                <ConfigField label={t("模板名（可选，默认用文件名；字母数字点下划线连字符）")}>
                  <input value={name} onChange={(e) => setName(e.target.value)} style={monoStyle} maxLength={64} placeholder="standard-lab" />
                </ConfigField>
                <ConfigField label={t("描述（可选）")}>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} maxLength={200} />
                </ConfigField>
              </>
            ) : showDetail ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{selected.name}</ConfigDetailTitle>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{formatSize(selected.size)}</span>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigButton variant="danger" size="small" onClick={() => void remove(selected)}>{t("删除")}</ConfigButton>
                  </ConfigDetailActions>
                </ConfigDetailHeader>
                {selected.description && <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{selected.description}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    <span style={{ width: 80, color: "var(--text-dim)" }}>{t("上传时间")}</span>
                    <span style={{ color: "var(--text)" }}>{new Date(selected.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {t("配置模板是管理员维护的标准 .pi/ 配置 + labs/ 打包（zip）。用户新建项目时可在向导中选择；已有项目可通过项目菜单「套用配置模板…」补装。")}
                </div>
              </>
            ) : (
              <ConfigEmptyState>{t("配置模板是管理员维护的标准 .pi/ 配置 + labs/ 打包（zip）。选择左侧模板查看详情，或点击左下角「上传模板」。")}</ConfigEmptyState>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      {/* Footer：状态 + 右下角操作（与模型页一致） */}
      <ConfigFooter status={
        <>
          {error && <span style={{ color: "#ef4444" }}>{error}</span>}
          {formError && <span style={{ color: "#ef4444" }}>{formError}</span>}
          {formMsg && !formError && <span style={{ color: "var(--accent)" }}>{formMsg}</span>}
        </>
      }>
        {showUpload && (
          <>
            <ConfigButton onClick={exitUpload}>{t("取消")}</ConfigButton>
            <ConfigButton variant="primary" onClick={() => void upload()} disabled={uploading}>
              {uploading ? t("上传中…") : t("上传")}
            </ConfigButton>
          </>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
