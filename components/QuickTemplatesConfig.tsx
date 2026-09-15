"use client";

import { useCallback, useEffect, useState } from "react";
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

interface Draft {
  name: string;
  description: string;
  systemPrompt: string;
  modelProvider: string;
  modelId: string;
  mcpServers: string;
}

const emptyDraft: Draft = { name: "", description: "", systemPrompt: "", modelProvider: "", modelId: "", mcpServers: "" };

function toDraft(t: QuickTemplate): Draft {
  return {
    name: t.name,
    description: t.description,
    systemPrompt: t.systemPrompt,
    modelProvider: t.model?.provider ?? "",
    modelId: t.model?.modelId ?? "",
    mcpServers: (t.mcpServers ?? []).join(", "),
  };
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
const textareaStyle: React.CSSProperties = {
  ...monoStyle,
  height: "auto",
  minHeight: 180,
  resize: "vertical",
  padding: 8,
  lineHeight: 1.5,
};

export function QuickTemplatesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
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

  const selectTemplate = (tpl: QuickTemplate) => {
    setCreating(false);
    setSelectedId(tpl.id);
    setDraft(toDraft(tpl));
    setFormError(null);
    setFormMsg(null);
  };

  const startCreate = () => {
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
        ...(draft.mcpServers.trim()
          ? { mcpServers: draft.mcpServers.split(",").map((s) => s.trim()).filter(Boolean) }
          : {}),
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
      setFormMsg(creating ? t("模板已创建。") : t("模板已保存。"));
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
    if (!window.confirm(t("确定删除模板「{name}」吗？", { name: tpl.name }))) return;
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
    <ConfigPanelShell embedded={embedded} title={t("快速会话模板")} closeLabel={t("i18n.close")} onClose={() => {}}>
      {/* Body */}
      <ConfigSplitView>
        {/* Left: template list（与模型页同构：列表 + 左下角新建） */}
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? <div className="config-sidebar-message">{t("加载模板…")}</div>
            : error ? <div className="config-sidebar-message is-error">{error}</div>
            : templates.length === 0 ? <div className="config-sidebar-message is-empty">{t("暂无模板")}</div>
            : templates.map((tpl) => (
              <ConfigSidebarItem key={tpl.id} active={!creating && selectedId === tpl.id} onClick={() => selectTemplate(tpl)}>
                <ConfigSidebarText className="is-grow">{tpl.name}</ConfigSidebarText>
                {tpl.builtin && <span className="config-scope-tag is-project">{t("默认")}</span>}
              </ConfigSidebarItem>
            ))}
          </ConfigSidebarList>
          {/* 新建入口固定在侧栏左下角（与模型页「添加 Provider」一致） */}
          <ConfigListAction onClick={startCreate} active={creating}>＋ {t("新增模板")}</ConfigListAction>
        </ConfigSidebar>

        {/* Right: detail / form */}
        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!showForm ? (
              <ConfigEmptyState>{t("模板决定快速会话的系统提示词、模型与 MCP 白名单；default 可编辑不可删除。选择左侧模板，或点击左下角「新增模板」。")}</ConfigEmptyState>
            ) : (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{creating ? t("新增模板") : draft.name || selected?.name}</ConfigDetailTitle>
                    {selected?.builtin && <span className="config-scope-tag is-project">{t("默认 · 不可删除")}</span>}
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    {!creating && selected && !selected.builtin && (
                      <ConfigButton variant="danger" size="small" onClick={() => void remove(selected)} disabled={saving}>{t("删除")}</ConfigButton>
                    )}
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                <ConfigField label={t("模板名称（用户可见，如「产品A助手」）")}>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} maxLength={60} />
                </ConfigField>
                <ConfigField label={t("描述（可选）")}>
                  <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={inputStyle} maxLength={300} />
                </ConfigField>
                <ConfigField label={t("系统提示词")}>
                  <textarea value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} style={textareaStyle} />
                </ConfigField>
                <div style={{ display: "flex", gap: 10 }}>
                  <ConfigField label={t("模型 Provider（可选，如 modelscope）")} style={{ flex: 1 }}>
                    <input value={draft.modelProvider} onChange={(e) => setDraft({ ...draft, modelProvider: e.target.value })} style={monoStyle} placeholder={t("默认用用户当前模型")} />
                  </ConfigField>
                  <ConfigField label={t("模型 ID（可选）")} style={{ flex: 1 }}>
                    <input value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })} style={monoStyle} placeholder="Qwen/Qwen3.5-27B" />
                  </ConfigField>
                </div>
                <ConfigField label={t("MCP 服务器允许列表（可选，逗号分隔服务器名；留空 = 用户配置的全部服务器）")}>
                  <input value={draft.mcpServers} onChange={(e) => setDraft({ ...draft, mcpServers: e.target.value })} style={monoStyle} placeholder="weather, db-query" />
                </ConfigField>
              </>
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
        {showForm && (
          <>
            <ConfigButton onClick={cancel}>{t("取消")}</ConfigButton>
            <ConfigButton variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t("保存中…") : t("保存")}
            </ConfigButton>
          </>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
