"use client";

import { useCallback, useEffect, useState } from "react";
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
 * 快速会话模板管理（设置面板，仅管理员）— 列表 + 编辑/新增/删除。
 * 内置默认模板可编辑不可删除。UI 走共享 Config* 组件（与技能/插件页同风格）。
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

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6,
  background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
};
const monoStyle: React.CSSProperties = { ...inputStyle, fontFamily: "var(--font-mono)" };

export function QuickTemplatesConfig({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<QuickTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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

  const startEdit = (tpl: QuickTemplate) => {
    setCreating(false);
    setEditingId(tpl.id);
    setDraft(toDraft(tpl));
    setFormError(null);
  };

  const startCreate = () => {
    setEditingId(null);
    setCreating(true);
    setDraft(emptyDraft);
    setFormError(null);
  };

  const cancel = () => {
    setEditingId(null);
    setCreating(false);
    setFormError(null);
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
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
          body: JSON.stringify({ id: editingId, template: payload }),
        });
      const data = (await res.json()) as { template?: QuickTemplate; errors?: Array<{ field: string; reason: string }>; error?: string };
      if (!res.ok) {
        throw new Error(data.errors?.map((e) => `${e.field}: ${e.reason}`).join("；") ?? data.error ?? `HTTP ${res.status}`);
      }
      await load();
      cancel();
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("快速会话模板")} onClose={() => {}}>
      <ConfigDetailStack className="is-fill">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ConfigDetailTitle>{t("快速会话模板")}</ConfigDetailTitle>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("模板决定快速会话的系统提示词、模型与 MCP 白名单；default 可编辑不可删除。")}
            </span>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            {!creating && !editingId && (
              <ConfigButton variant="primary" onClick={startCreate}>＋ {t("新增模板")}</ConfigButton>
            )}
          </ConfigDetailActions>
        </ConfigDetailHeader>

        {error && (
          <div role="alert" style={{ color: "#f87171", fontSize: 12, padding: "6px 10px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>{t("加载模板…")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {templates.map((tpl) => (
              <div key={tpl.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{tpl.name}</span>
                  {tpl.builtin && <span className="config-scope-tag is-project">{t("默认 · 不可删除")}</span>}
                  {tpl.model && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{tpl.model.provider}/{tpl.model.modelId}</span>}
                  <div style={{ flex: 1 }} />
                  <ConfigButton size="small" onClick={() => startEdit(tpl)}>{t("编辑")}</ConfigButton>
                  {!tpl.builtin && (
                    <ConfigButton size="small" variant="danger" onClick={() => void remove(tpl)}>{t("删除")}</ConfigButton>
                  )}
                </div>
                {tpl.description && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{tpl.description}</div>}
                {tpl.mcpServers && tpl.mcpServers.length > 0 && (
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                    MCP: {tpl.mcpServers.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {(creating || editingId) && (
          <div style={{ border: "1px solid rgba(37,99,235,0.35)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{creating ? t("新增模板") : t("编辑模板")}</div>
            <ConfigField label={t("模板名称（用户可见，如「产品A助手」）")}>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} maxLength={60} />
            </ConfigField>
            <ConfigField label={t("描述（可选）")}>
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={inputStyle} maxLength={300} />
            </ConfigField>
            <ConfigField label={t("系统提示词")}>
              <textarea value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} rows={6} style={monoStyle} />
            </ConfigField>
            <div style={{ display: "flex", gap: 8 }}>
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
            {formError && <div role="alert" style={{ color: "#f87171", fontSize: 11 }}>{formError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <ConfigButton variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? t("保存中…") : t("保存")}
              </ConfigButton>
              <ConfigButton onClick={cancel}>{t("取消")}</ConfigButton>
            </div>
          </div>
        )}
      </ConfigDetailStack>
    </ConfigPanelShell>
  );
}
