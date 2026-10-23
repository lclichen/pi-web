"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { registerSettingsDirty } from "@/lib/settings-dirty";
import { useConfirm } from "./use-confirm";
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
 * 快速会话模板管理（设置面板，仅管理员）— 左侧模板列表 + 右侧编辑表单。
 * 内置默认模板可编辑不可删除。布局走共享 Config* 组件（与模型/子代理页同构：
 * 列表在左、新建入口在侧栏左下角、保存固定在右下角）。
 */

interface QuickTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: { provider: string; modelId: string };
  mcpServers?: string[];
  builtin?: boolean;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface Draft {
  name: string;
  description: string;
  systemPrompt: string;
  modelProvider: string;
  modelId: string;
  mcpServers: string[];
}

// 选项值用 JSON 编码 [provider, modelId]——两者都可能含 "/"，不能用拼接分隔。
function modelOptionValue(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

const emptyDraft: Draft = { name: "", description: "", systemPrompt: "", modelProvider: "", modelId: "", mcpServers: [] };

function toDraft(t: QuickTemplate): Draft {
  return {
    name: t.name,
    description: t.description,
    systemPrompt: t.systemPrompt,
    modelProvider: t.model?.provider ?? "",
    modelId: t.model?.modelId ?? "",
    mcpServers: [...(t.mcpServers ?? [])],
  };
}

// 草稿是否有未保存修改：新建态与任意非空字段比较；编辑态与所选模板快照逐字段比较。
function isDraftDirty(creating: boolean, draft: Draft, selected: QuickTemplate | null): boolean {
  if (creating) {
    return draft.name !== "" || draft.description !== "" || draft.systemPrompt !== ""
      || draft.modelProvider !== "" || draft.modelId !== "" || draft.mcpServers.length > 0;
  }
  if (!selected) return false;
  const base = toDraft(selected);
  return draft.name !== base.name
    || draft.description !== base.description
    || draft.systemPrompt !== base.systemPrompt
    || draft.modelProvider !== base.modelProvider
    || draft.modelId !== base.modelId
    || draft.mcpServers.join("\n") !== base.mcpServers.join("\n");
}

export function QuickTemplatesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  // 已配置的 MCP 服务器名——白名单多选数据源（见下方 /api/mcp 拉取）。
  const [mcpServerNames, setMcpServerNames] = useState<string[] | null>(null);
  // 仅快速会话可见的服务器（dataDir/mcp-quick.json 物化到 quick home）——
  // 模板白名单同样可以引用它们，chip 上加 ⚡ 标记区分。
  const [quickScopedServers, setQuickScopedServers] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<QuickTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMsg, setFormMsg] = useState<string | null>(null);

  const selected = templates.find((tpl) => tpl.id === selectedId) ?? null;
  const showForm = creating || selected !== null;

  // 向设置面板外壳报告未保存状态（Esc/遮罩关闭前会请求确认）。
  useEffect(
    () => registerSettingsDirty("quick-templates", () => isDraftDirty(creating, draft, selected)),
    [creating, draft, selected],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/quick-templates");
      const data = (await res.json()) as { templates?: QuickTemplate[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTemplates(data.templates ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 可选模型列表：从全局模型配置拉取，模板编辑用下拉直接选择，
  // 取代手填 provider/modelId（手填拼写对不上时保存报错，是"模型ID
  // 存不下"反复出现的直接原因）。不阻塞模板加载——失败仅退回手填。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { modelList?: ModelOption[] };
        if (!cancelled && Array.isArray(data.modelList)) {
          setModelOptions(data.modelList.filter((m) => m && typeof m.id === "string" && typeof m.provider === "string"));
        }
      } catch {
        // 列表拉不到时下面仍渲染手填输入，功能不回退
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 已配置的 MCP 服务器名（/api/mcp 的 servers 列表）——白名单多选数据源；
  // 拉取失败时下方退回手填输入，功能不回退。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/mcp?quick=1", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { servers?: Array<{ name?: string }> };
        if (!cancelled && Array.isArray(data.servers)) {
          const all = data.servers
            .map((s: { name?: string; scope?: string }) => ({ name: typeof s?.name === "string" ? s.name : "", scope: typeof s?.scope === "string" ? s.scope : "" }))
            .filter((x) => x.name.length > 0);
          setMcpServerNames(all.map((x) => x.name));
          setQuickScopedServers(new Set(all.filter((x) => x.scope === "quick").map((x) => x.name)));
        }
      } catch { /* 忽略：退回手填 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // 切换/新建前，若有未保存草稿先请求放弃确认（此前是无声丢弃）。
  const confirmDiscardIfNeeded = async (): Promise<boolean> => {
    if (!isDraftDirty(creating, draft, selected)) return true;
    return confirm({
      title: t("quickTemplates.discardDraftTitle"),
      message: t("quickTemplates.discardDraftMessage"),
      confirmLabel: t("common.discardChanges"),
      abortLabel: t("common.cancel"),
      danger: true,
    });
  };

  const selectTemplate = async (tpl: QuickTemplate) => {
    if (tpl.id !== selectedId || creating) {
      if (!(await confirmDiscardIfNeeded())) return;
    }
    setCreating(false);
    setSelectedId(tpl.id);
    setDraft(toDraft(tpl));
    setFormError(null);
    setFormMsg(null);
  };

  const startCreate = async () => {
    if (!(await confirmDiscardIfNeeded())) return;
    setSelectedId(null);
    setCreating(true);
    setDraft(emptyDraft);
    setFormError(null);
    setFormMsg(null);
  };

  const cancel = () => {
    setFormError(null);
    setFormMsg(null);
    if (creating) {
      setCreating(false);
      setDraft(emptyDraft);
    } else if (selected) {
      setDraft(toDraft(selected));
    }
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    setFormMsg(null);
    try {
      const payload: Record<string, unknown> = {
        name: draft.name,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        ...(draft.modelProvider.trim() && draft.modelId.trim()
          ? { model: { provider: draft.modelProvider.trim(), modelId: draft.modelId.trim() } }
          : {}),
        ...(draft.mcpServers.length > 0 ? { mcpServers: draft.mcpServers } : {}),
      };
      const res = creating
        ? await fetch("/api/quick-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        : await fetch("/api/quick-templates", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selectedId, template: payload }),
        });
      const data = (await res.json()) as { template?: QuickTemplate; errors?: Array<{ field: string; reason: string }>; error?: string };
      if (!res.ok) {
        throw new Error(data.errors?.map((e) => `${e.field}: ${e.reason}`).join("；") ?? data.error ?? `HTTP ${res.status}`);
      }
      await load();
      setFormMsg(creating ? t("quickTemplates.templateCreated") : t("quickTemplates.templateSaved"));
      setCreating(false);
      if (data.template) {
        setSelectedId(data.template.id);
        setDraft(toDraft(data.template));
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tpl: QuickTemplate) => {
    const ok = await confirm({
      title: t("common.delete"),
      message: t("quickTemplates.deleteTemplate", { name: tpl.name }),
      confirmLabel: t("common.delete"),
      abortLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/quick-templates?id=${encodeURIComponent(tpl.id)}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (selectedId === tpl.id) {
        setSelectedId(null);
        setDraft(emptyDraft);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("quickTemplates.quickSessionTemplates")} closeLabel={t("i18n.close")} onClose={() => {}}>

      {/* Body */}
      <ConfigSplitView>
        {/* Left: template list（与模型页同构：列表 + 左下角新建） */}
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? <div className="config-sidebar-message">{t("quickTemplates.loading")}</div>
            : error ? <div className="config-sidebar-message is-error">{error}</div>
            : templates.length === 0 ? <div className="config-sidebar-message is-empty">{t("quickTemplates.emptyList")}</div>
            : templates.map((tpl) => (
              <ConfigSidebarItem key={tpl.id} active={!creating && selectedId === tpl.id} onClick={() => void selectTemplate(tpl)}>
                <ConfigSidebarText className="is-grow">{tpl.name}</ConfigSidebarText>
                {tpl.builtin && <span className="config-scope-tag is-project">{t("quickTemplates.default")}</span>}
              </ConfigSidebarItem>
            ))}
          </ConfigSidebarList>
          {/* 新建入口固定在侧栏左下角（与模型页「添加 Provider」一致） */}
          <ConfigListAction onClick={() => void startCreate()} active={creating}>{t("quickTemplates.newTemplate")}</ConfigListAction>
        </ConfigSidebar>

        {/* Right: detail / form */}
        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!showForm ? (
              <ConfigEmptyState>{t("quickTemplates.templatesDriveHint")}</ConfigEmptyState>
            ) : (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{creating ? t("quickTemplates.newTemplate") : draft.name || selected?.name}</ConfigDetailTitle>
                    {selected?.builtin && <span className="config-scope-tag is-project">{t("quickTemplates.defaultDeletable")}</span>}
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    {!creating && selected && !selected.builtin && (
                      <ConfigButton variant="danger" size="small" onClick={() => void remove(selected)} disabled={saving}>{t("common.delete")}</ConfigButton>
                    )}
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                <ConfigField label={t("quickTemplates.templateNameUserVisibleE")}>
                  <input className="config-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} />
                </ConfigField>
                <ConfigField label={t("common.descriptionOptional")}>
                  <input className="config-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={300} />
                </ConfigField>
                <ConfigField label={t("quickTemplates.systemPrompt")}>
                  <textarea className="config-input is-mono config-textarea" value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} />
                </ConfigField>
                {modelOptions.length > 0 ? (
                  <ConfigField label={t("quickTemplates.modelOptionalPick")}>
                    <select
                      className="config-input is-mono"
                      value={draft.modelProvider && draft.modelId ? modelOptionValue(draft.modelProvider, draft.modelId) : ""}
                      onChange={(e) => {
                        if (!e.target.value) {
                          setDraft({ ...draft, modelProvider: "", modelId: "" });
                          return;
                        }
                        try {
                          const [provider, modelId] = JSON.parse(e.target.value) as [string, string];
                          setDraft({ ...draft, modelProvider: provider, modelId });
                      } catch { /* 非法选项值按清空处理 */ }
                    }}
                    >
                      <option value="">{t("quickTemplates.modelFollowDefault")}</option>
                      {((draft.modelProvider.trim() && draft.modelId.trim()
                        && !modelOptions.some((m) => m.provider === draft.modelProvider && m.id === draft.modelId))
                        ? ([{ id: draft.modelId, name: draft.modelId, provider: draft.modelProvider }] as ModelOption[]).concat(modelOptions)
                        : modelOptions
                      ).map((m) => (
                        <option key={`${m.provider}/${m.id}`} value={modelOptionValue(m.provider, m.id)}>
                          {m.name === m.id ? `${m.provider} / ${m.id}` : `${m.name}（${m.provider} / ${m.id}）`}
                        </option>
                      ))}
                    </select>
                  </ConfigField>
                ) : (
                  <div style={{ display: "flex", gap: 10 }}>
                    <ConfigField label={t("quickTemplates.modelProviderOptionalEG")} style={{ flex: 1 }}>
                      <input className="config-input is-mono" value={draft.modelProvider} onChange={(e) => setDraft({ ...draft, modelProvider: e.target.value })} placeholder={t("quickTemplates.defaultsUsersCurrentModel")} />
                    </ConfigField>
                    <ConfigField label={t("quickTemplates.modelIdOptional")} style={{ flex: 1 }}>
                      <input className="config-input is-mono" value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })} placeholder="Qwen/Qwen3.5-27B" />
                    </ConfigField>
                  </div>
                )}
                <ConfigField label={t("quickTemplates.mcpAllowlistPick")}>
                  {mcpServerNames !== null ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {mcpServerNames.map((server: string) => {
                        const checked = draft.mcpServers.includes(server);
                        return (
                          <label
                            key={server}
                            className="quick-mcp-chip"
                            data-checked={checked}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setDraft({
                                  ...draft,
                                  mcpServers: checked
                                    ? draft.mcpServers.filter((s) => s !== server)
                                    : [...draft.mcpServers, server],
                                });
                              }}
                            />
                            {server}{quickScopedServers.has(server) ? " ⚡" : ""}
                          </label>
                        );
                      })}
                      {mcpServerNames.length === 0 && (
                        <span style={{ alignSelf: "center", fontSize: 11, color: "var(--text-dim)" }}>{t("quickTemplates.mcpNoServers")}</span>
                      )}
                      <span style={{ alignSelf: "center", fontSize: 11, color: "var(--text-dim)" }}>{t("quickTemplates.mcpAllowlistEmptyMeansAll")}</span>
                    </div>
                  ) : (
                    <input
                      className="config-input is-mono"
                      value={draft.mcpServers.join(", ")}
                      onChange={(e) => setDraft({ ...draft, mcpServers: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                      placeholder="weather, db-query"
                    />
                  )}
                </ConfigField>
              </>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      {/* Footer：状态 + 右下角操作（与模型页一致） */}
      <ConfigFooter status={
        <>
          {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          {formError && <span style={{ color: "var(--danger)" }}>{formError}</span>}
          {formMsg && !formError && <span style={{ color: "var(--accent)" }}>{formMsg}</span>}
        </>
      }>
        {showForm && (
          <>
            <ConfigButton onClick={cancel}>{t("common.cancel")}</ConfigButton>
            <ConfigButton variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </ConfigButton>
          </>
        )}
      </ConfigFooter>
      {confirmDialog}
    </ConfigPanelShell>
  );
}
