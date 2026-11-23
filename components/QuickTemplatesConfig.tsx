"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { registerSettingsDirty } from "@/lib/settings-dirty";
import { serversForQuickTools } from "@/lib/quick-tools";
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
  /** Whole-server grants (legacy); union with mcpTools. */
  mcpServers?: string[];
  /** Tool-level grants: exact `<server>_<tool>` names. */
  mcpTools?: string[];
  builtin?: boolean;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
}

/** /api/tools/discover response row (probe=true). */
interface McpDiscoveryServer {
  server: string;
  scope?: "project" | "user" | "global" | "quick";
  tools: McpToolInfo[];
  error?: string;
}

interface Draft {
  name: string;
  description: string;
  systemPrompt: string;
  modelProvider: string;
  modelId: string;
  mcpServers: string[];
  mcpTools: string[];
}

// 选项值用 JSON 编码 [provider, modelId]——两者都可能含 "/"，不能用拼接分隔。
function modelOptionValue(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId]);
}

function sameList(a: string[], b: string[]): boolean {
  return [...a].sort().join("\n") === [...b].sort().join("\n");
}

const emptyDraft: Draft = {
  name: "",
  description: "",
  systemPrompt: "",
  modelProvider: "",
  modelId: "",
  mcpServers: [],
  mcpTools: [],
};

function toDraft(t: QuickTemplate): Draft {
  return {
    name: t.name,
    description: t.description,
    systemPrompt: t.systemPrompt,
    modelProvider: t.model?.provider ?? "",
    modelId: t.model?.modelId ?? "",
    mcpServers: [...(t.mcpServers ?? [])],
    mcpTools: [...(t.mcpTools ?? [])],
  };
}

// 草稿是否有未保存修改：新建态与任意非空字段比较；编辑态与所选模板快照逐字段比较。
function isDraftDirty(creating: boolean, draft: Draft, selected: QuickTemplate | null): boolean {
  if (creating) {
    return (
      draft.name !== "" ||
      draft.description !== "" ||
      draft.systemPrompt !== "" ||
      draft.modelProvider !== "" ||
      draft.modelId !== "" ||
      draft.mcpServers.length > 0 ||
      draft.mcpTools.length > 0
    );
  }
  if (!selected) return false;
  const base = toDraft(selected);
  return (
    draft.name !== base.name ||
    draft.description !== base.description ||
    draft.systemPrompt !== base.systemPrompt ||
    draft.modelProvider !== base.modelProvider ||
    draft.modelId !== base.modelId ||
    !sameList(draft.mcpServers, base.mcpServers) ||
    !sameList(draft.mcpTools, base.mcpTools)
  );
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
  // 工具级选择的数据源：按需探测（与子智能体配置同一交互）。null = 尚未探测；
  // 探测失败也是 []（此时仍可按整服务器授权，已选工具保留可见）。
  const [mcpDiscovery, setMcpDiscovery] = useState<McpDiscoveryServer[] | null>(null);
  const [mcpDiscovering, setMcpDiscovering] = useState(false);
  const [mcpDiscoveryError, setMcpDiscoveryError] = useState<string | null>(null);
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

  useEffect(() => {
    void load();
  }, [load]);

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
          setModelOptions(
            data.modelList.filter((m) => m && typeof m.id === "string" && typeof m.provider === "string"),
          );
        }
      } catch {
        // 列表拉不到时下面仍渲染手填输入，功能不回退
      }
    })();
    return () => {
      cancelled = true;
    };
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
            .map((s: { name?: string; scope?: string }) => ({
              name: typeof s?.name === "string" ? s.name : "",
              scope: typeof s?.scope === "string" ? s.scope : "",
            }))
            .filter((x) => x.name.length > 0);
          setMcpServerNames(all.map((x) => x.name));
          setQuickScopedServers(new Set(all.filter((x) => x.scope === "quick").map((x) => x.name)));
        }
      } catch {
        /* 忽略：退回手填 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 按需探测 quick 作用域里每个 MCP 服务器的真实工具列表（与子智能体页
  // 同一交互）。探测失败不清空已选工具：工具级条目仍可保留/手动移除。
  const loadMcpDiscovery = useCallback(async () => {
    setMcpDiscovering(true);
    setMcpDiscoveryError(null);
    try {
      const res = await fetch("/api/tools/discover?quick=1&probe=true", { cache: "no-store" });
      const data = (await res.json()) as { mcp?: McpDiscoveryServer[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      const rows = Array.isArray(data.mcp)
        ? data.mcp.filter((row): row is McpDiscoveryServer => Boolean(row && typeof row.server === "string"))
        : [];
      setMcpDiscovery(rows);
      // 探测同时补全服务器名：部署级 quick 条目可能还没物化进快速 home。
      setMcpServerNames((prev) => {
        const names = new Set(prev ?? []);
        for (const row of rows) names.add(row.server);
        return [...names];
      });
      setQuickScopedServers((prev) => {
        const next = new Set(prev);
        for (const row of rows) if (row.scope === "quick") next.add(row.server);
        return next;
      });
    } catch (e) {
      setMcpDiscovery([]);
      setMcpDiscoveryError(e instanceof Error ? e.message : String(e));
    } finally {
      setMcpDiscovering(false);
    }
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
        // null = 显式清除（省略字段在 PATCH 合并语义下等于"保持原值"）。
        model:
          draft.modelProvider.trim() && draft.modelId.trim()
            ? { provider: draft.modelProvider.trim(), modelId: draft.modelId.trim() }
            : null,
        // 始终发送数组：空数组才能清空旧白名单。
        mcpServers: draft.mcpServers,
        mcpTools: draft.mcpTools,
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
      const data = (await res.json()) as {
        template?: QuickTemplate;
        errors?: Array<{ field: string; reason: string }>;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(
          data.errors?.map((e) => `${e.field}: ${e.reason}`).join("；") ?? data.error ?? `HTTP ${res.status}`,
        );
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

  const toggleWholeServer = (server: string, on: boolean) => {
    setDraft({
      ...draft,
      mcpServers: on
        ? [...new Set([...draft.mcpServers, server])]
        : draft.mcpServers.filter((s) => s !== server),
    });
  };

  const toggleMcpTool = (tool: string, on: boolean) => {
    setDraft({
      ...draft,
      mcpTools: on ? [...new Set([...draft.mcpTools, tool])] : draft.mcpTools.filter((t) => t !== tool),
    });
  };

  // 服务器分组：配置列表 + 探测结果并集；探测按需触发（null=未探测）。
  const discoveryByServer = new Map((mcpDiscovery ?? []).map((row) => [row.server, row]));
  const mcpGroups = [
    ...new Set([...(mcpServerNames ?? []), ...(mcpDiscovery ?? []).map((row) => row.server)]),
  ].map((server) => ({
    server,
    tools: discoveryByServer.get(server)?.tools ?? [],
    error: discoveryByServer.get(server)?.error,
    probed: discoveryByServer.has(server),
  }));
  const knownMcpServers = mcpGroups.map((group) => group.server);
  // 已选但当前配置/探测里不存在的条目：保留可见、可取消，绝不静默丢弃。
  const staleMcpServers = draft.mcpServers.filter((server) => !knownMcpServers.includes(server));
  const staleMcpTools = draft.mcpTools.filter(
    (tool) =>
      serversForQuickTools([tool], knownMcpServers).length === 0 &&
      !staleMcpServers.some((server) => tool.startsWith(server + "_")),
  );

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("quickTemplates.quickSessionTemplates")}
      closeLabel={t("i18n.close")}
      onClose={() => {}}
    >
      {/* Body */}
      <ConfigSplitView>
        {/* Left: template list（与模型页同构：列表 + 左下角新建） */}
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? (
              <div className="config-sidebar-message">{t("quickTemplates.loading")}</div>
            ) : error ? (
              <div className="config-sidebar-message is-error">{error}</div>
            ) : templates.length === 0 ? (
              <div className="config-sidebar-message is-empty">{t("quickTemplates.emptyList")}</div>
            ) : (
              templates.map((tpl) => (
                <ConfigSidebarItem
                  key={tpl.id}
                  active={!creating && selectedId === tpl.id}
                  onClick={() => void selectTemplate(tpl)}
                >
                  <ConfigSidebarText className="is-grow">{tpl.name}</ConfigSidebarText>
                  {tpl.builtin && <span className="config-scope-tag is-project">{t("quickTemplates.default")}</span>}
                </ConfigSidebarItem>
              ))
            )}
          </ConfigSidebarList>
          {/* 新建入口固定在侧栏左下角（与模型页「添加 Provider」一致） */}
          <ConfigListAction onClick={() => void startCreate()} active={creating}>
            {t("quickTemplates.newTemplate")}
          </ConfigListAction>
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
                    <ConfigDetailTitle>
                      {creating ? t("quickTemplates.newTemplate") : draft.name || selected?.name}
                    </ConfigDetailTitle>
                    {selected?.builtin && (
                      <span className="config-scope-tag is-project">{t("quickTemplates.defaultDeletable")}</span>
                    )}
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    {!creating && selected && !selected.builtin && (
                      <ConfigButton
                        variant="danger"
                        size="small"
                        onClick={() => void remove(selected)}
                        disabled={saving}
                      >
                        {t("common.delete")}
                      </ConfigButton>
                    )}
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                <ConfigField label={t("quickTemplates.templateNameUserVisibleE")}>
                  <input
                    className="config-input"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    maxLength={60}
                  />
                </ConfigField>
                <ConfigField label={t("common.descriptionOptional")}>
                  <input
                    className="config-input"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    maxLength={300}
                  />
                </ConfigField>
                <ConfigField label={t("quickTemplates.systemPrompt")}>
                  <textarea
                    className="config-input is-mono config-textarea"
                    value={draft.systemPrompt}
                    onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                  />
                </ConfigField>
                {modelOptions.length > 0 ? (
                  <ConfigField label={t("quickTemplates.modelOptionalPick")}>
                    <select
                      className="config-input is-mono"
                      value={
                        draft.modelProvider && draft.modelId ? modelOptionValue(draft.modelProvider, draft.modelId) : ""
                      }
                      onChange={(e) => {
                        if (!e.target.value) {
                          setDraft({ ...draft, modelProvider: "", modelId: "" });
                          return;
                        }
                        try {
                          const [provider, modelId] = JSON.parse(e.target.value) as [string, string];
                          setDraft({ ...draft, modelProvider: provider, modelId });
                        } catch {
                          /* 非法选项值按清空处理 */
                        }
                      }}
                    >
                      <option value="">{t("quickTemplates.modelFollowDefault")}</option>
                      {(draft.modelProvider.trim() &&
                      draft.modelId.trim() &&
                      !modelOptions.some((m) => m.provider === draft.modelProvider && m.id === draft.modelId)
                        ? (
                            [{ id: draft.modelId, name: draft.modelId, provider: draft.modelProvider }] as ModelOption[]
                          ).concat(modelOptions)
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
                      <input
                        className="config-input is-mono"
                        value={draft.modelProvider}
                        onChange={(e) => setDraft({ ...draft, modelProvider: e.target.value })}
                        placeholder={t("quickTemplates.defaultsUsersCurrentModel")}
                      />
                    </ConfigField>
                    <ConfigField label={t("quickTemplates.modelIdOptional")} style={{ flex: 1 }}>
                      <input
                        className="config-input is-mono"
                        value={draft.modelId}
                        onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                        placeholder="Qwen/Qwen3.5-27B"
                      />
                    </ConfigField>
                  </div>
                )}
                <ConfigField label={t("quickTemplates.mcpAllowlistPick")}>
                  {mcpServerNames !== null ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <ConfigButton
                          size="small"
                          onClick={() => void loadMcpDiscovery()}
                          disabled={mcpDiscovering}
                        >
                          {mcpDiscovering
                            ? t("quickTemplates.mcpDiscovering")
                            : mcpDiscovery
                              ? t("quickTemplates.mcpRediscover")
                              : t("quickTemplates.mcpDiscover")}
                        </ConfigButton>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          {t("quickTemplates.mcpSelectionSummary", {
                            servers: draft.mcpServers.length,
                            tools: draft.mcpTools.length,
                          })}
                        </span>
                      </div>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {t("quickTemplates.mcpAllowlistEmptyMeansAll")}
                      </span>
                      {mcpDiscoveryError && (
                        <span style={{ fontSize: 11, color: "var(--danger)" }}>
                          {t("quickTemplates.mcpDiscoverFailed", { error: mcpDiscoveryError })}
                        </span>
                      )}
                      {mcpGroups.length === 0 && staleMcpServers.length === 0 && staleMcpTools.length === 0 && (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          {t("quickTemplates.mcpNoServers")}
                        </span>
                      )}
                      {mcpGroups.map((group) => {
                        const whole = draft.mcpServers.includes(group.server);
                        const selectedForServer = draft.mcpTools.filter(
                          (tool) => serversForQuickTools([tool], knownMcpServers)[0] === group.server,
                        );
                        const discoveredNames = new Set(group.tools.map((tool) => `${group.server}_${tool.name}`));
                        const notDiscovered = selectedForServer.filter((tool) => !discoveredNames.has(tool));
                        return (
                          <div
                            key={group.server}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              padding: "8px 10px",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                              <label className="quick-mcp-chip" data-checked={whole}>
                                <input
                                  type="checkbox"
                                  checked={whole}
                                  onChange={() => toggleWholeServer(group.server, !whole)}
                                />
                                {group.server}
                                {quickScopedServers.has(group.server) ? " ⚡" : ""}
                                <span style={{ color: whole ? "var(--accent)" : "var(--text-dim)", fontSize: 10 }}>
                                  {t("quickTemplates.mcpWholeServer")}
                                </span>
                              </label>
                              {group.probed && group.tools.length > 0 && (
                                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                                  {t("quickTemplates.mcpToolCount", { count: group.tools.length })}
                                </span>
                              )}
                              {group.probed && group.error && (
                                <span style={{ fontSize: 10, color: "var(--warning, #f59e0b)" }}>{group.error}</span>
                              )}
                            </div>
                            {!whole &&
                              (group.tools.length > 0 ? (
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                                    gap: 6,
                                  }}
                                >
                                  {group.tools.map((tool) => {
                                    const prefixed = `${group.server}_${tool.name}`;
                                    const checked = draft.mcpTools.includes(prefixed);
                                    return (
                                      <label
                                        key={prefixed}
                                        className="quick-mcp-chip"
                                        data-checked={checked}
                                        title={tool.description}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => toggleMcpTool(prefixed, !checked)}
                                        />
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{prefixed}</span>
                                      </label>
                                    );
                                  })}
                                  {notDiscovered.map((tool) => (
                                    <label key={tool} className="quick-mcp-chip" data-checked title={tool}>
                                      <input
                                        type="checkbox"
                                        checked
                                        onChange={() => toggleMcpTool(tool, false)}
                                      />
                                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tool}</span>
                                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                                        {t("quickTemplates.mcpNotDiscovered")}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                    {group.probed
                                      ? group.error
                                        ? t("quickTemplates.mcpProbeBlocked")
                                        : t("quickTemplates.mcpNoTools")
                                      : t("quickTemplates.mcpDiscoverHint")}
                                  </span>
                                  {notDiscovered.map((tool) => (
                                    <label key={tool} className="quick-mcp-chip" data-checked title={tool}>
                                      <input
                                        type="checkbox"
                                        checked
                                        onChange={() => toggleMcpTool(tool, false)}
                                      />
                                      <span>{tool}</span>
                                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                                        {group.probed
                                          ? t("quickTemplates.mcpNotDiscovered")
                                          : t("quickTemplates.mcpNotProbed")}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              ))}
                          </div>
                        );
                      })}
                      {(staleMcpServers.length > 0 || staleMcpTools.length > 0) && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase" }}>
                            {t("quickTemplates.mcpStaleEntries")}
                          </span>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {staleMcpServers.map((server) => (
                              <label key={`server:${server}`} className="quick-mcp-chip" data-checked>
                                <input
                                  type="checkbox"
                                  checked
                                  onChange={() => toggleWholeServer(server, false)}
                                />
                                <span>{server}</span>
                                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                                  {t("quickTemplates.mcpWholeServer")}
                                </span>
                              </label>
                            ))}
                            {staleMcpTools.map((tool) => (
                              <label key={`tool:${tool}`} className="quick-mcp-chip" data-checked>
                                <input type="checkbox" checked onChange={() => toggleMcpTool(tool, false)} />
                                <span>{tool}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <input
                        className="config-input is-mono"
                        value={draft.mcpServers.join(", ")}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            mcpServers: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder={t("quickTemplates.mcpServersManual")}
                      />
                      <input
                        className="config-input is-mono"
                        value={draft.mcpTools.join(", ")}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            mcpTools: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder={t("quickTemplates.mcpToolsManual")}
                      />
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {t("quickTemplates.mcpAllowlistHint")}
                      </span>
                    </div>
                  )}
                </ConfigField>
              </>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

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
