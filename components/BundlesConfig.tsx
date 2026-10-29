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
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "./SettingsUi";
import { useConfirm } from "./use-confirm";

/**
 * Agents 管理（设置面板，仅管理员）— 以"Agent 定义"子页为主：
 * 配置包（.zip / 加密 .apkg）即 Agent 定义的载体。左侧定义列表 + 右侧
 * 详情：包身份/版本（manifest v2）、依赖（manifest.package.dependencies
 * 或 readme）、内容清单（扩展/技能/子智能体/模型/MCP/实验手册）与点击
 * 即看的文件预览（GET /api/bundles/[name]/inspect）。上传/删除沿用
 * /api/bundles。布局与模型/子代理页同构。
 */

interface BundleMeta {
  name: string;
  description: string;
  size: number;
  createdAt: number;
  /** "apkg" = 加密配置包（套用时内存解密，导入后禁止再导出）。 */
  kind: "zip" | "apkg";
  /** 内容版本（.apkg 头部/manifest v2；明文 zip 可能为空）。 */
  version: string;
}

interface InspectEntry {
  path: string;
  size: number;
}
interface InspectModels {
  file: string;
  models: string[];
}
interface InspectMcp {
  file: string;
  servers: string[];
}

interface BundleInspection {
  package: { name: string; title: string; description: string; version: string; channel: string } | null;
  format: { version: number | null; exportedAt: string | null };
  dependencies: string[];
  hasReadme: boolean;
  agentsMdBytes: number | null;
  counts: {
    extensions: number;
    skills: number;
    agents: number;
    models: number;
    mcp: number;
    labs: number;
    other: number;
  };
  extensions: InspectEntry[];
  skills: InspectEntry[];
  agents: InspectEntry[];
  models: InspectModels[];
  mcp: InspectMcp[];
  labs: InspectEntry[];
  otherFiles: InspectEntry[];
  manifest: unknown;
}

interface FilePreview {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content?: string;
}

function formatSize(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function BundlesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  /** 子页：Agent 定义（配置包）｜解密密钥（.apkg KEK，只写不可读）。 */
  const [tab, setTab] = useState<"definitions" | "apkgKeys">("definitions");
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

  // 详情：内容解析（选中即拉取）与文件预览。
  const [inspection, setInspection] = useState<BundleInspection | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    void load();
  }, [load]);

  const loadInspection = useCallback(async (bundleName: string) => {
    setInspectLoading(true);
    setInspectError(null);
    setInspection(null);
    setPreview(null);
    setPreviewError(null);
    setOpenSections(new Set());
    try {
      const res = await fetch(`/api/bundles/${encodeURIComponent(bundleName)}/inspect`);
      const data = (await res.json()) as { inspection?: BundleInspection; error?: string };
      if (!res.ok || !data.inspection) throw new Error(data.error ?? `HTTP ${res.status}`);
      setInspection(data.inspection);
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : String(e));
    } finally {
      setInspectLoading(false);
    }
  }, []);

  const openPreview = useCallback(async (bundleName: string, path: string) => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(
        `/api/bundles/${encodeURIComponent(bundleName)}/inspect?path=${encodeURIComponent(path)}`,
      );
      const data = (await res.json()) as FilePreview & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPreview(data);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const selectBundle = (bundle: BundleMeta) => {
    setUploadMode(false);
    setSelectedName(bundle.name);
    setFormError(null);
    setFormMsg(null);
    void loadInspection(bundle.name);
  };

  const startUpload = () => {
    setSelectedName(null);
    setUploadMode(true);
    setInspection(null);
    setPreview(null);
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
      setFormError(t("bundles.chooseZipApkgFile2"));
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
      if (data.name) {
        setSelectedName(data.name);
        void loadInspection(data.name);
      }
      setFormMsg(t("bundles.bundleUploaded"));
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (bundle: BundleMeta) => {
    const ok = await confirm({
      title: t("common.delete"),
      message: t("bundles.deleteBundleProjectsAlreadyUsing", { name: bundle.name }),
      confirmLabel: t("common.delete"),
      abortLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/bundles?name=${encodeURIComponent(bundle.name)}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (selectedName === bundle.name) {
        setSelectedName(null);
        setInspection(null);
        setPreview(null);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const entryRow = (bundleName: string, entryItem: InspectEntry) => (
    <button
      key={entryItem.path}
      type="button"
      className={`bundle-file-row${preview?.path === entryItem.path ? " is-active" : ""}`}
      onClick={() => void openPreview(bundleName, entryItem.path)}
      title={entryItem.path}
    >
      <span className="bundle-file-path">{entryItem.path}</span>
      <span className="bundle-file-size">{formatSize(entryItem.size)}</span>
    </button>
  );

  const sectionBlock = (key: string, title: string, count: number, children: React.ReactNode) => {
    if (count === 0 && key !== "deps") return null;
    const open = openSections.has(key);
    return (
      <div className="bundle-section">
        <button type="button" className="bundle-section-toggle" aria-expanded={open} onClick={() => toggleSection(key)}>
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.12s", flexShrink: 0 }}
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span style={{ flex: 1, textAlign: "left" }}>{title}</span>
          <span className="bundle-section-count">{count}</span>
        </button>
        {open && <div className="bundle-section-body">{children}</div>}
      </div>
    );
  };

  const showUpload = uploadMode;
  const showDetail = !showUpload && selected !== null;
  const detailName = selected?.name ?? "";

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("bundles.agentsAdmin")}
      closeLabel={t("i18n.close")}
      onClose={() => {}}
    >
      {/* 子页导航：Agent 定义 + .apkg 解密密钥。 */}
      <div className="bundle-subtabs" role="tablist" aria-label={t("bundles.agentsAdmin")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "definitions"}
          className={`bundle-subtab${tab === "definitions" ? " is-active" : ""}`}
          onClick={() => setTab("definitions")}
        >
          {t("bundles.agentDefinitions")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "apkgKeys"}
          className={`bundle-subtab${tab === "apkgKeys" ? " is-active" : ""}`}
          onClick={() => {
            setUploadMode(false);
            setTab("apkgKeys");
          }}
        >
          {t("bundles.apkgKeysTab")}
        </button>
      </div>

      {tab === "apkgKeys" ? (
        <ApkgKeysPanel />
      ) : (
        <ConfigSplitView>
          {/* Left: Agent 定义列表（与模型页同构：列表 + 左下角上传） */}
          <ConfigSidebar>
            <ConfigSidebarList>
              {loading ? (
                <div className="config-sidebar-message">{t("bundles.loadingConfigBundles")}</div>
              ) : error ? (
                <div className="config-sidebar-message is-error">{error}</div>
              ) : bundles.length === 0 ? (
                <div className="config-sidebar-message is-empty">{t("bundles.templatesYet")}</div>
              ) : (
                bundles.map((b) => (
                  <ConfigSidebarItem
                    key={b.name}
                    active={!showUpload && selectedName === b.name}
                    onClick={() => selectBundle(b)}
                  >
                    <ConfigSidebarText className="is-grow" title={b.description}>
                      <span
                        style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {b.name}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: 10,
                          color: b.kind === "apkg" ? "var(--accent)" : "var(--text-dim)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {b.kind === "apkg" ? t("bundles.encrypted") : "zip"}
                        {b.version ? ` · v${b.version}` : ""}
                      </span>
                    </ConfigSidebarText>
                    <ConfigSidebarText className="is-muted">{formatSize(b.size)}</ConfigSidebarText>
                  </ConfigSidebarItem>
                ))
              )}
            </ConfigSidebarList>
            {/* 上传入口固定在侧栏左下角（与模型页「添加 Provider」一致） */}
            <ConfigListAction onClick={startUpload} active={showUpload}>
              {t("bundles.uploadBundle")}
            </ConfigListAction>
          </ConfigSidebar>

          {/* Right: upload form / agent definition detail */}
          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {showUpload ? (
                <>
                  <ConfigDetailHeader>
                    <ConfigDetailHeaderInfo>
                      <ConfigDetailTitle>{t("bundles.uploadNew")}</ConfigDetailTitle>
                    </ConfigDetailHeaderInfo>
                  </ConfigDetailHeader>
                  <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                    {t("bundles.configBundlesStandardPiConfig")}
                  </span>
                  <ConfigField label={t("bundles.chooseZipApkgFile")}>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".zip,.apkg"
                      onChange={(e) => setFileChosen(e.target.files?.[0]?.name ?? null)}
                      style={{ fontSize: 11, color: "var(--text-muted)" }}
                    />
                    {fileChosen && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{fileChosen}</span>}
                  </ConfigField>
                  <ConfigField label={t("bundles.bundleNameOptionalDefaultsFile")}>
                    <input
                      className="config-input is-mono"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={64}
                      placeholder="standard-lab"
                    />
                  </ConfigField>
                  <ConfigField label={t("common.descriptionOptional")}>
                    <input
                      className="config-input"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={200}
                    />
                  </ConfigField>
                </>
              ) : showDetail && selected ? (
                <>
                  <ConfigDetailHeader>
                    <ConfigDetailHeaderInfo>
                      <ConfigDetailTitle>{inspection?.package?.title ?? selected.name}</ConfigDetailTitle>
                      <span className="config-scope-tag is-project">
                        v{inspection?.package?.version ?? selected.version ?? "0"}
                      </span>
                      <span className="config-scope-tag">
                        {selected.kind === "apkg" ? t("bundles.encrypted") : "zip"}
                      </span>
                      {inspection?.package?.channel && inspection.package.channel !== "stable" && (
                        <span className="config-scope-tag">{inspection.package.channel}</span>
                      )}
                    </ConfigDetailHeaderInfo>
                    <ConfigDetailActions>
                      <ConfigButton variant="danger" size="small" onClick={() => void remove(selected)}>
                        {t("common.delete")}
                      </ConfigButton>
                    </ConfigDetailActions>
                  </ConfigDetailHeader>

                  {(inspection?.package?.description || selected.description) && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                      {inspection?.package?.description || selected.description}
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ width: 80, color: "var(--text-dim)" }}>{t("bundles.uploaded")}</span>
                      <span style={{ color: "var(--text)" }}>{new Date(selected.createdAt).toLocaleString()}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ width: 80, color: "var(--text-dim)" }}>{t("bundles.type")}</span>
                      <span style={{ color: "var(--text)" }}>
                        {selected.kind === "apkg" ? t("bundles.encryptedPackageApkg") : t("bundles.plainPackageZip")}
                        {` · ${formatSize(selected.size)}`}
                      </span>
                    </div>
                    {selected.kind === "apkg" && (
                      <div style={{ display: "flex", gap: 10 }}>
                        <span style={{ width: 80, color: "var(--text-dim)" }}>{t("bundles.notes")}</span>
                        <span style={{ color: "var(--text-muted)" }}>{t("bundles.apkgApplyNote")}</span>
                      </div>
                    )}
                  </div>

                  {inspectLoading && (
                    <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("apiKeys.loading")}</div>
                  )}
                  {inspectError && (
                    <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
                      {inspectError}
                    </div>
                  )}

                  {inspection && (
                    <>
                      <ConfigSectionTitle>{t("bundles.detailContents")}</ConfigSectionTitle>
                      <div className="bundle-counts">
                        <span>
                          {t("bundles.sectionExtensions")} {inspection.counts.extensions}
                        </span>
                        <span>
                          {t("bundles.sectionSkills")} {inspection.counts.skills}
                        </span>
                        <span>
                          {t("bundles.sectionAgents")} {inspection.counts.agents}
                        </span>
                        <span>
                          {t("bundles.sectionModels")} {inspection.counts.models}
                        </span>
                        <span>
                          {t("bundles.sectionMcp")} {inspection.counts.mcp}
                        </span>
                        <span>
                          {t("bundles.sectionLabs")} {inspection.counts.labs}
                        </span>
                        {inspection.counts.other > 0 && (
                          <span>
                            {t("bundles.sectionOther")} {inspection.counts.other}
                          </span>
                        )}
                      </div>

                      {sectionBlock(
                        "extensions",
                        t("bundles.sectionExtensions"),
                        inspection.extensions.length,
                        inspection.extensions.map((e) => entryRow(detailName, e)),
                      )}
                      {sectionBlock(
                        "skills",
                        t("bundles.sectionSkills"),
                        inspection.skills.length,
                        inspection.skills.map((e) => entryRow(detailName, e)),
                      )}
                      {sectionBlock(
                        "agents",
                        t("bundles.sectionAgents"),
                        inspection.agents.length,
                        inspection.agents.map((e) => entryRow(detailName, e)),
                      )}
                      {sectionBlock(
                        "models",
                        t("bundles.sectionModels"),
                        inspection.models.reduce((s, m) => s + m.models.length, 0),
                        inspection.models.map((m) => (
                          <div key={m.file} className="bundle-chip-list">
                            {m.models.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="bundle-chip is-mono"
                                onClick={() => void openPreview(detailName, m.file)}
                                title={m.file}
                              >
                                {id}
                              </button>
                            ))}
                          </div>
                        )),
                      )}
                      {sectionBlock(
                        "mcp",
                        t("bundles.sectionMcp"),
                        inspection.mcp.reduce((s, m) => s + m.servers.length, 0),
                        inspection.mcp.map((m) => (
                          <div key={m.file} className="bundle-chip-list">
                            {m.servers.map((srv) => (
                              <button
                                key={srv}
                                type="button"
                                className="bundle-chip is-mono"
                                onClick={() => void openPreview(detailName, m.file)}
                                title={m.file}
                              >
                                {srv}
                              </button>
                            ))}
                          </div>
                        )),
                      )}
                      {sectionBlock(
                        "labs",
                        t("bundles.sectionLabs"),
                        inspection.labs.length,
                        inspection.labs.map((e) => entryRow(detailName, e)),
                      )}
                      {inspection.otherFiles.length > 0 &&
                        sectionBlock(
                          "other",
                          t("bundles.sectionOther"),
                          inspection.otherFiles.length,
                          inspection.otherFiles.map((e) => entryRow(detailName, e)),
                        )}

                      <ConfigSectionTitle>{t("bundles.detailDependencies")}</ConfigSectionTitle>
                      {inspection.dependencies.length > 0 ? (
                        <div className="bundle-chip-list">
                          {inspection.dependencies.map((dep) => (
                            <span key={dep} className="bundle-chip">
                              {dep}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="settings-general-description" style={{ margin: 0 }}>
                          {t("bundles.detailNoDeps")}
                        </p>
                      )}
                      {inspection.hasReadme && (
                        <button
                          type="button"
                          className="bundle-file-row"
                          onClick={() => void openPreview(detailName, "readme.md")}
                        >
                          <span className="bundle-file-path">readme.md</span>
                          <span className="bundle-file-size">{t("bundles.detailPreview")}</span>
                        </button>
                      )}
                      {inspection.agentsMdBytes !== null && (
                        <button
                          type="button"
                          className="bundle-file-row"
                          onClick={() => void openPreview(detailName, "agents.md")}
                        >
                          <span className="bundle-file-path">agents.md · {formatSize(inspection.agentsMdBytes)}</span>
                          <span className="bundle-file-size">{t("bundles.detailPreview")}</span>
                        </button>
                      )}

                      {(preview || previewLoading || previewError) && (
                        <>
                          <ConfigSectionTitle>{t("bundles.detailPreview")}</ConfigSectionTitle>
                          {previewLoading && (
                            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("apiKeys.loading")}</div>
                          )}
                          {previewError && (
                            <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
                              {previewError}
                            </div>
                          )}
                          {preview && (
                            <div className="bundle-preview">
                              <div className="bundle-preview-header">
                                <span className="bundle-file-path">{preview.path}</span>
                                <span className="bundle-file-size">
                                  {formatSize(preview.size)}
                                  {preview.truncated ? ` · ${t("bundles.truncatedPreview")}` : ""}
                                </span>
                              </div>
                              {preview.binary ? (
                                <div className="bundle-preview-body" style={{ color: "var(--text-dim)" }}>
                                  {t("bundles.binaryPreview", { size: formatSize(preview.size) })}
                                </div>
                              ) : (
                                <pre className="bundle-preview-body">{preview.content}</pre>
                              )}
                            </div>
                          )}
                        </>
                      )}

                      {inspection.manifest !== null &&
                        sectionBlock(
                          "manifest",
                          t("bundles.detailManifest"),
                          1,
                          <pre className="bundle-preview-body">{JSON.stringify(inspection.manifest, null, 2)}</pre>,
                        )}
                    </>
                  )}
                </>
              ) : (
                <ConfigEmptyState>{t("bundles.configBundlesStandardPiConfig")}</ConfigEmptyState>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>
      )}

      {/* Footer：状态 + 右下角操作（与模型页一致） */}
      <ConfigFooter
        status={
          <>
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
            {formError && <span style={{ color: "var(--danger)" }}>{formError}</span>}
            {formMsg && !formError && <span style={{ color: "var(--accent)" }}>{formMsg}</span>}
          </>
        }
      >
        {showUpload && (
          <>
            <ConfigButton onClick={exitUpload}>{t("common.cancel")}</ConfigButton>
            <ConfigButton variant="primary" onClick={() => void upload()} disabled={uploading}>
              {uploading ? t("bundles.uploading") : t("bundles.upload")}
            </ConfigButton>
          </>
        )}
      </ConfigFooter>
      {confirmDialog}
    </ConfigPanelShell>
  );
}

// ---------------------------------------------------------------------------
// .apkg 解密密钥（只写不可读）
// ---------------------------------------------------------------------------

interface ApkgKeyInfo {
  keyId: string;
  source: "file" | "env";
  addedAt: string | null;
  addedBy: string | null;
}

/**
 * 密钥管理面：GET 只返回元数据（keyId/来源/添加人/时间）+ 解密组件状态；
 * POST 添加或轮换（同一 keyId 重新提交）；DELETE 吊销。KEK 本体只在提交时
 * 单向进入服务端存储，任何响应/页面都不回显。
 */
function ApkgKeysPanel() {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [keys, setKeys] = useState<ApkgKeyInfo[]>([]);
  const [tool, setTool] = useState<{ path: string | null; configured: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  /** null = 未选；"add" = 添加表单；其他 = 选中 keyId 的详情。 */
  const [active, setActive] = useState<string | null>(null);
  const [keyId, setKeyId] = useState("");
  const [kek, setKek] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/apkg-keys");
      const data = (await res.json()) as {
        keys?: ApkgKeyInfo[];
        tool?: { path: string | null; configured: boolean };
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setKeys(data.keys ?? []);
      setTool(data.tool ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startAdd = () => {
    setActive("add");
    setKeyId("");
    setKek("");
    setError(null);
    setNotice(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/apkg-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId: keyId.trim(), kek }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setKek("");
      setNotice(t("bundles.apkgKeysAdded"));
      await load();
      setActive(keyId.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (target: ApkgKeyInfo) => {
    if (target.source === "env") {
      setError(t("bundles.apkgKeysEnvNote"));
      return;
    }
    const ok = await confirm({
      title: t("bundles.apkgKeysRevoke"),
      message: t("bundles.apkgKeysRevokeConfirm", { keyId: target.keyId }),
      confirmLabel: t("bundles.apkgKeysRevoke"),
      abortLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/apkg-keys?keyId=${encodeURIComponent(target.keyId)}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setActive(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = keys.find((k) => k.keyId === active) ?? null;
  const toolLine = tool?.path ? `${t("bundles.apkgKeysToolOk")} · ${tool.path}` : t("bundles.apkgKeysToolMissing");

  return (
    <>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? (
              <div className="config-sidebar-message">{t("apiKeys.loading")}</div>
            ) : keys.length === 0 ? (
              <div className="config-sidebar-message is-empty">{t("bundles.apkgKeysEmpty")}</div>
            ) : (
              keys.map((k) => (
                <ConfigSidebarItem
                  key={k.keyId}
                  active={active === k.keyId}
                  onClick={() => {
                    setActive(k.keyId);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  <ConfigSidebarText className="is-grow">
                    <span
                      style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={k.keyId}
                    >
                      {k.keyId}
                    </span>
                    <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)" }}>
                      {k.source === "env" ? t("bundles.apkgKeysSourceEnv") : t("bundles.apkgKeysSourceFile")}
                      {k.addedAt ? ` · ${new Date(k.addedAt).toLocaleDateString()}` : ""}
                    </span>
                  </ConfigSidebarText>
                </ConfigSidebarItem>
              ))
            )}
          </ConfigSidebarList>
          <ConfigListAction onClick={startAdd} active={active === "add"}>
            {t("bundles.apkgKeysAdd")}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {active === "add" ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{t("bundles.apkgKeysAdd")}</ConfigDetailTitle>
                  </ConfigDetailHeaderInfo>
                </ConfigDetailHeader>
                <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {t("bundles.apkgKeysDesc")}
                </span>
                <ConfigField label={t("bundles.apkgKeysKeyId")}>
                  <input
                    className="config-input is-mono"
                    value={keyId}
                    onChange={(e) => setKeyId(e.target.value)}
                    maxLength={64}
                    placeholder={t("bundles.apkgKeysKeyIdPlaceholder")}
                  />
                </ConfigField>
                <ConfigField label={t("bundles.apkgKeysKek")}>
                  <input
                    className="config-input is-mono"
                    type="password"
                    value={kek}
                    onChange={(e) => setKek(e.target.value)}
                    autoComplete="off"
                    placeholder={t("bundles.apkgKeysKekPlaceholder")}
                  />
                </ConfigField>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {t("bundles.apkgKeysNeverReadable")}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <ConfigButton
                    variant="primary"
                    onClick={() => void submit()}
                    disabled={busy || keyId.trim().length === 0 || kek.trim().length === 0}
                  >
                    {busy ? t("bundles.apkgKeysSubmitBusy") : t("bundles.apkgKeysSubmit")}
                  </ConfigButton>
                </div>
              </>
            ) : selected ? (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{selected.keyId}</ConfigDetailTitle>
                    <span className="config-scope-tag">
                      {selected.source === "env" ? t("bundles.apkgKeysSourceEnv") : t("bundles.apkgKeysSourceFile")}
                    </span>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigButton
                      variant="danger"
                      size="small"
                      disabled={busy || selected.source === "env"}
                      onClick={() => void revoke(selected)}
                    >
                      {t("bundles.apkgKeysRevoke")}
                    </ConfigButton>
                  </ConfigDetailActions>
                </ConfigDetailHeader>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                  {selected.addedAt && (
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ width: 80, color: "var(--text-dim)" }}>{t("bundles.apkgKeysAddedAt")}</span>
                      <span style={{ color: "var(--text)" }}>{new Date(selected.addedAt).toLocaleString()}</span>
                    </div>
                  )}
                  {selected.addedBy && (
                    <div style={{ display: "flex", gap: 10 }}>
                      <span style={{ width: 80, color: "var(--text-dim)" }}>{t("bundles.apkgKeysAddedBy")}</span>
                      <span style={{ color: "var(--text)" }}>{selected.addedBy}</span>
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {t("bundles.apkgKeysNeverReadable")}
                </div>
                {selected.source === "env" && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    {t("bundles.apkgKeysEnvNote")}
                  </div>
                )}
              </>
            ) : (
              <ConfigEmptyState>{t("bundles.apkgKeysDesc")}</ConfigEmptyState>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={
          <>
            <span style={{ color: tool?.path ? "var(--text-dim)" : "var(--danger)" }}>{toolLine}</span>
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
            {notice && <span style={{ color: "var(--accent)" }}>{notice}</span>}
          </>
        }
      >
        <></>
      </ConfigFooter>
      {confirmDialog}
    </>
  );
}
