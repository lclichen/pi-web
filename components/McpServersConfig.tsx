"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  ConfigScope,
  McpConfigDocument,
  McpServerInfo,
  McpServerTools,
  McpSettings,
  McpTool,
  ServerEntry,
  WebPreferences,
} from "@/lib/api-types";
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
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSplitView,
  ConfigSwitch,
} from "./SettingsUi";

// 与模型/技能页同款输入框样式。
const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 30,
  padding: "3px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  height: "auto",
  minHeight: 56,
  resize: "vertical",
  padding: 8,
  lineHeight: 1.5,
};

function shortenPath(p: string): string { return p.replace(/^\/(?:Users|home)\/[^/]+/, "~"); }
function parseLines(raw: string): string[] { return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function parseKv(raw: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(raw)) { const idx = line.search(sep); if (idx === -1) continue; const key = line.slice(0, idx).trim(); const val = line.slice(idx + 1).trim(); if (key) out[key] = val; }
  return out;
}
function kvToString(record: Record<string, string> | undefined, sep: string): string {
  if (!record) return ""; return Object.entries(record).map(([k, v]) => `${k}${sep}${v}`).join("\n");
}

interface ServerForm {
  name: string; scope: ConfigScope; transport: "stdio" | "http";
  command: string; args: string; env: string; cwd: string;
  url: string; headers: string; auth: "none" | "oauth" | "bearer";
  bearerToken: string; bearerTokenEnv: string;
  lifecycle: string; idleTimeout: string; toolTimeoutMs: string;
  directToolsMode: "off" | "all" | "list"; directToolsList: string;
  includeTools: string; excludeTools: string; debug: boolean;
}

function emptyServerForm(scope: ConfigScope = "project"): ServerForm {
  return { name: "", scope, transport: "http", command: "", args: "", env: "", cwd: "", url: "", headers: "", auth: "none", bearerToken: "", bearerTokenEnv: "", lifecycle: "keep-alive", idleTimeout: "", toolTimeoutMs: "", directToolsMode: "all", directToolsList: "", includeTools: "", excludeTools: "", debug: false };
}

function entryToForm(name: string, scope: ConfigScope, entry: ServerEntry): ServerForm {
  const transport = entry.url ? "http" : "stdio";
  const dt = entry.directTools;
  let directToolsMode: ServerForm["directToolsMode"] = "off"; let directToolsList = "";
  if (dt === true) directToolsMode = "all"; else if (Array.isArray(dt)) { directToolsMode = "list"; directToolsList = dt.join(", "); }
  return {
    name, scope, transport,
    command: entry.command ?? "", args: entry.args?.join("\n") ?? "", env: kvToString(entry.env, "="), cwd: entry.cwd ?? "",
    url: entry.url ?? "", headers: kvToString(entry.headers, ": "),
    auth: entry.auth === "oauth" ? "oauth" : entry.auth === "bearer" ? "bearer" : "none",
    bearerToken: entry.bearerToken ?? "", bearerTokenEnv: entry.bearerTokenEnv ?? "",
    lifecycle: entry.lifecycle ?? "", idleTimeout: entry.idleTimeout !== undefined ? String(entry.idleTimeout) : "",
    toolTimeoutMs: entry.toolTimeoutMs !== undefined ? String(entry.toolTimeoutMs) : (entry.requestTimeoutMs !== undefined ? String(entry.requestTimeoutMs) : ""),
    directToolsMode, directToolsList,
    includeTools: entry.includeTools?.join(", ") ?? "",
    excludeTools: entry.excludeTools?.join(", ") ?? "", debug: entry.debug === true,
  };
}

function formToEntry(form: ServerForm): ServerEntry {
  const entry: ServerEntry = {};
  if (form.transport === "stdio") {
    if (form.command.trim()) entry.command = form.command.trim();
    const args = parseLines(form.args); if (args.length) entry.args = args;
    const env = parseKv(form.env, /=/); if (Object.keys(env).length) entry.env = env;
    if (form.cwd.trim()) entry.cwd = form.cwd.trim();
  } else {
    if (form.url.trim()) entry.url = form.url.trim();
    const headers = parseKv(form.headers, /:\s*/); if (Object.keys(headers).length) entry.headers = headers;
    if (form.auth === "oauth") entry.auth = "oauth";
    else if (form.auth === "bearer") { entry.auth = "bearer"; if (form.bearerToken.trim()) entry.bearerToken = form.bearerToken.trim(); if (form.bearerTokenEnv.trim()) entry.bearerTokenEnv = form.bearerTokenEnv.trim(); }
  }
  if (form.lifecycle) entry.lifecycle = form.lifecycle as ServerEntry["lifecycle"];
  if (form.idleTimeout.trim() !== "") { const n = Number(form.idleTimeout); if (Number.isFinite(n)) entry.idleTimeout = n; }
  if (form.toolTimeoutMs.trim() !== "") { const n = Number(form.toolTimeoutMs); if (Number.isFinite(n)) entry.toolTimeoutMs = n; }
  if (form.directToolsMode === "all") entry.directTools = true;
  else if (form.directToolsMode === "list") { const list = form.directToolsList.split(",").map((s) => s.trim()).filter(Boolean); if (list.length) entry.directTools = list; }
  const include = form.includeTools.split(",").map((s) => s.trim()).filter(Boolean); if (include.length) entry.includeTools = include;
  const exclude = form.excludeTools.split(",").map((s) => s.trim()).filter(Boolean); if (exclude.length) entry.excludeTools = exclude;
  if (form.debug) entry.debug = true;
  return entry;
}

export function McpServersConfig({ cwd, onClose, embedded = false }: { cwd: string; onClose: () => void; embedded?: boolean }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<McpConfigDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ServerForm>(emptyServerForm());
  const [originalName, setOriginalName] = useState<string>("");
  const [originalScope, setOriginalScope] = useState<ConfigScope>("project");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [toolMap, setToolMap] = useState<Map<string, McpServerTools>>(new Map());
  const [probingAll, setProbingAll] = useState(false);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<McpSettings>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [prefs, setPrefs] = useState<WebPreferences>({ mcpEnabled: true, subagentsEnabled: true, labVerifyEnabled: true });

  const servers = useMemo(() => doc?.servers ?? [], [doc]);
  const grouped = useMemo(() => {
    return (["project", "global"] as ConfigScope[])
      .map((scope) => ({ scope, servers: servers.filter((s) => s.scope === scope) }))
      .filter((g) => g.servers.length > 0);
  }, [servers]);

  const loadDoc = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json()) as McpConfigDocument & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDoc(data);
      if (data.settings) setSettingsDraft(data.settings);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }, [cwd]);

  const probeAll = useCallback(async () => {
    setProbingAll(true);
    try {
      const res = await fetch(`/api/tools/discover?cwd=${encodeURIComponent(cwd)}&probe=true`);
      const data = (await res.json()) as { mcp?: McpServerTools[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      const map = new Map<string, McpServerTools>();
      for (const srv of data.mcp ?? []) map.set(`${srv.scope}\0${srv.server}`, srv);
      setToolMap(map);
    } catch { /* ignore */ }
    finally { setProbingAll(false); }
  }, [cwd]);

  useEffect(() => { void loadDoc().then(() => void probeAll()); }, [loadDoc, probeAll]);

  useEffect(() => {
    fetch(`/api/preferences?cwd=${encodeURIComponent(cwd)}`).then(r => r.json()).then((p: WebPreferences) => setPrefs(p)).catch(() => {});
  }, [cwd]);

  const togglePref = async (key: "mcpEnabled", value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try {
      await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, ...next }) });
    } catch { /* ignore */ }
  };

  const selectServer = (info: McpServerInfo) => {
    setForm(entryToForm(info.name, info.scope, info.entry));
    setOriginalName(info.name); setOriginalScope(info.scope);
    setSelectedKey(`${info.scope}\0${info.name}`);
    setCreating(false); setFormError(null); setFormMsg(null); setShowAdvanced(false);
    setExpandedServers((prev) => new Set(prev).add(`${info.scope}\0${info.name}`));
  };

  const startCreate = () => {
    setCreating(true); setForm(emptyServerForm("project")); setSelectedKey(null);
    setFormError(null); setFormMsg(null); setShowAdvanced(false);
  };

  const set = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true); setFormError(null); setFormMsg(null);
    const entry = formToEntry(form);
    if (!entry.command && !entry.url) { setFormError("A command (stdio) or url (http) is required"); setSaving(false); return; }
    try {
      if (creating) {
        if (!form.name.trim()) { setFormError("Name is required"); setSaving(false); return; }
        const res = await fetch("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, scope: form.scope, name: form.name.trim(), entry }) });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setOriginalName(form.name.trim()); setOriginalScope(form.scope);
        setFormMsg("Server created."); setCreating(false); setSelectedKey(`${form.scope}\0${form.name.trim()}`);
      } else {
        const res = await fetch(`/api/mcp/servers/${encodeURIComponent(originalName)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, scope: originalScope, entry }) });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setFormMsg("Server saved.");
      }
      await loadDoc(); void probeAll();
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (creating) return;
    if (!window.confirm(`Delete server "${originalName}"?`)) return;
    setSaving(true); setFormError(null);
    try {
      const res = await fetch(`/api/mcp/servers/${encodeURIComponent(originalName)}?cwd=${encodeURIComponent(cwd)}&scope=${originalScope}`, { method: "DELETE" });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSelectedKey(null); setForm(emptyServerForm());
      await loadDoc(); void probeAll();
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };

  const probeOne = async (name: string, scope: ConfigScope) => {
    const entry = formToEntry(form);
    if (!entry.command && !entry.url) return;
    try {
      const res = await fetch("/api/mcp/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry, timeoutMs: 10000 }) });
      const result = (await res.json()) as { tools?: McpTool[]; error?: string; needsAuth?: boolean };
      const map = new Map(toolMap);
      map.set(`${scope}\0${name}`, { server: name, scope, transport: entry.url ? "http" : "stdio", tools: result.tools ?? [], error: result.error, needsAuth: result.needsAuth });
      setToolMap(map);
    } catch { /* ignore */ }
  };

  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      const scope = doc?.settingsScope ?? "project";
      const res = await fetch("/api/mcp/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, scope, settings: settingsDraft }) });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setFormMsg("Settings saved."); await loadDoc();
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)); }
    finally { setSettingsSaving(false); }
  };

  const toggleExpand = (key: string) => setExpandedServers((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  const showForm = creating || selectedKey !== null;
  const diagnostics = doc?.diagnostics ?? [];
  const scopeGroupLabel = (scope: string) => scope === "project" ? t("agents.scope.project") : t("agents.scope.global");

  return (
    <ConfigPanelShell embedded={embedded} title={t("MCP 服务器")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>
      {/* 顶部工具栏：启用开关 + 探测/设置（共享组件，与子代理页同款）。 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "7px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {probingAll && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{t("探测中…")}</span>}
        <span style={{ fontSize: 11, color: prefs.mcpEnabled ? "var(--text-muted)" : "var(--text-dim)" }}>{t("启用")}</span>
        <ConfigSwitch checked={prefs.mcpEnabled} label={t("启用")} onChange={(v) => void togglePref("mcpEnabled", v)} />
        <ConfigButton size="small" onClick={() => void probeAll()} disabled={probingAll}>{t("刷新工具")}</ConfigButton>
        <ConfigButton size="small" onClick={() => setShowSettings((v) => !v)}>{showSettings ? t("收起设置") : t("设置")}</ConfigButton>
      </div>

      {showSettings && (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <div style={{ width: 140 }}><ConfigField label="toolPrefix"><select style={inputStyle} value={settingsDraft.toolPrefix ?? ""} onChange={(e) => setSettingsDraft((s) => ({ ...s, toolPrefix: (e.target.value || undefined) as McpSettings["toolPrefix"] }))}><option value="">(default)</option><option value="server">server</option><option value="none">none</option><option value="short">short</option><option value="mcp">mcp</option></select></ConfigField></div>
          <div style={{ width: 110 }}><ConfigField label="idleTimeout (min)"><input style={inputStyle} value={settingsDraft.idleTimeout ?? ""} onChange={(e) => setSettingsDraft((s) => ({ ...s, idleTimeout: e.target.value === "" ? undefined : Number(e.target.value) }))} /></ConfigField></div>
          <ConfigButton variant="primary" onClick={saveSettings} disabled={settingsSaving}>{settingsSaving ? t("保存中…") : t("保存设置")}</ConfigButton>
        </div>
      )}

      {/* Body */}
      <ConfigSplitView>
        {/* Left: server + tool tree（与模型页同构：列表 + 左下角新建） */}
        <ConfigSidebar>
          <ConfigSidebarList>
            {diagnostics.filter((d) => d.parseError).map((d) => (<div key={`diag-${d.scope}`} style={{ padding: "3px 8px", fontSize: 10, color: "#ef4444" }} title={d.parseError}>{d.scope}: invalid JSON</div>))}
            {loading ? <div className="config-sidebar-message">{t("i18n.loading")}</div>
            : error ? <div className="config-sidebar-message is-error">{error}</div>
            : servers.length === 0 ? <div className="config-sidebar-message is-empty">{t("暂无 MCP 服务器")}</div>
            : grouped.map((group) => (
              <div key={group.scope} className="config-sidebar-group">
                <ConfigSidebarGroupLabel>{scopeGroupLabel(group.scope)}</ConfigSidebarGroupLabel>
                {group.servers.map((srv) => {
                  const key = `${srv.scope}\0${srv.name}`;
                  const isSelected = !creating && selectedKey === key;
                  const isExpanded = expandedServers.has(key);
                  const toolInfo = toolMap.get(key);
                  const toolCount = toolInfo?.tools.length ?? 0;
                  return (
                    <div key={key}>
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <button onClick={() => toggleExpand(key)} aria-label={isExpanded ? t("收起") : t("展开")} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: "0 2px", fontSize: 10, flexShrink: 0 }}>{isExpanded ? "▼" : "▶"}</button>
                        <ConfigSidebarItem active={isSelected} onClick={() => selectServer(srv)} style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 11, fontWeight: isSelected ? 600 : 400, display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden" }}>
                            <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: srv.transport === "http" ? "#2563eb33" : "#16a34a33", color: srv.transport === "http" ? "#60a5fa" : "#4ade80", flexShrink: 0 }}>{srv.transport}</span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{srv.name}</span>
                            {srv.directToolsOn && <span style={{ fontSize: 8, color: "var(--accent)" }}>DT</span>}
                            {toolInfo?.error && <span style={{ fontSize: 8, color: "#f59e0b" }}>!</span>}
                            {!toolInfo?.error && toolCount > 0 && <span style={{ fontSize: 8, color: "var(--text-dim)" }}>{toolCount}</span>}
                          </span>
                        </ConfigSidebarItem>
                      </div>
                      {isExpanded && (
                        <div style={{ paddingLeft: 18, paddingBottom: 4 }}>
                          {toolInfo?.error ? (
                            <div style={{ fontSize: 10, color: toolInfo.needsAuth ? "#f59e0b" : "#ef4444", padding: "2px 0" }}>{toolInfo.needsAuth ? "Auth required" : toolInfo.error.slice(0, 60)}</div>
                          ) : toolCount > 0 ? toolInfo!.tools.map((tool) => (
                            <div key={tool.name} style={{ fontSize: 10, padding: "1px 0", display: "flex", gap: 4, alignItems: "baseline" }}>
                              <code style={{ fontFamily: "var(--font-mono)", color: "var(--accent)", fontSize: 10 }}>{srv.name}_{tool.name}</code>
                              {tool.description && <span style={{ color: "var(--text-dim)", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tool.description.slice(0, 50)}</span>}
                            </div>
                          )) : probingAll ? <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 0" }}>probing...</div> : <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 0" }}>No tools</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </ConfigSidebarList>
          {/* 新建入口固定在侧栏左下角（与模型页「添加 Provider」一致） */}
          <ConfigListAction onClick={startCreate} active={creating}>{t("新建服务器")}</ConfigListAction>
        </ConfigSidebar>

        {/* Right: detail / form */}
        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!showForm ? (
              <ConfigEmptyState>{t("选择或新建 MCP 服务器")}</ConfigEmptyState>
            ) : (
              <>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{creating ? t("新建服务器") : originalName}</ConfigDetailTitle>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    {!creating && (
                      <ConfigButton variant="danger" size="small" onClick={remove} disabled={saving}>{t("删除")}</ConfigButton>
                    )}
                  </ConfigDetailActions>
                </ConfigDetailHeader>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 140px" }}><ConfigField label="Name"><input style={inputStyle} value={form.name} disabled={!creating} onChange={(e) => set("name", e.target.value)} placeholder="LithoChat" /></ConfigField></div>
                  <div style={{ width: 110 }}><ConfigField label="Scope"><select style={inputStyle} value={form.scope} disabled={!creating} onChange={(e) => set("scope", e.target.value as ConfigScope)}><option value="project">project</option><option value="global">global</option></select></ConfigField></div>
                  <div style={{ width: 110 }}><ConfigField label="Connection"><select style={inputStyle} value={form.transport} onChange={(e) => set("transport", e.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">http</option></select></ConfigField></div>
                </div>

                {form.transport === "stdio" ? (
                  <>
                    <ConfigField label="Command"><input style={inputStyle} value={form.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" /></ConfigField>
                    <ConfigField label="Args (one per line)"><textarea style={textareaStyle} value={form.args} onChange={(e) => set("args", e.target.value)} /></ConfigField>
                    <ConfigField label="Env (KEY=VALUE per line)"><textarea style={{ ...textareaStyle, minHeight: 48 }} value={form.env} onChange={(e) => set("env", e.target.value)} /></ConfigField>
                    <ConfigField label="Working directory"><input style={inputStyle} value={form.cwd} onChange={(e) => set("cwd", e.target.value)} /></ConfigField>
                  </>
                ) : (
                  <>
                    <ConfigField label="URL"><input style={inputStyle} value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="http://host:port/mcp" /></ConfigField>
                    <ConfigField label="Headers (KEY: VALUE per line)"><textarea style={{ ...textareaStyle, minHeight: 48 }} value={form.headers} onChange={(e) => set("headers", e.target.value)} /></ConfigField>
                    <div style={{ display: "flex", gap: 10 }}>
                      <div style={{ width: 120 }}><ConfigField label="Auth"><select style={inputStyle} value={form.auth} onChange={(e) => set("auth", e.target.value as ServerForm["auth"])}><option value="none">none</option><option value="bearer">bearer</option><option value="oauth">oauth</option></select></ConfigField></div>
                      {form.auth === "bearer" && (<><div style={{ flex: 1 }}><ConfigField label="Bearer token"><input style={inputStyle} value={form.bearerToken} onChange={(e) => set("bearerToken", e.target.value)} /></ConfigField></div><div style={{ flex: 1 }}><ConfigField label="Env var name"><input style={inputStyle} value={form.bearerTokenEnv} onChange={(e) => set("bearerTokenEnv", e.target.value)} /></ConfigField></div></>)}
                    </div>
                  </>
                )}

                {/* Common params */}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ width: 140 }}><ConfigField label="lifecycle"><select style={inputStyle} value={form.lifecycle} onChange={(e) => set("lifecycle", e.target.value)}><option value="">(default)</option><option value="keep-alive">keep-alive</option><option value="lazy">lazy</option><option value="lazy-keep-alive">lazy-keep-alive</option><option value="eager">eager</option></select></ConfigField></div>
                  <div style={{ width: 130 }}><ConfigField label="idleTimeout"><input style={inputStyle} value={form.idleTimeout} onChange={(e) => set("idleTimeout", e.target.value)} placeholder="10000" /></ConfigField></div>
                  <div style={{ width: 150 }}><ConfigField label="toolTimeoutMs"><input style={inputStyle} value={form.toolTimeoutMs} onChange={(e) => set("toolTimeoutMs", e.target.value)} placeholder="1800000" /></ConfigField></div>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ width: 140 }}><ConfigField label="directTools"><select style={inputStyle} value={form.directToolsMode} onChange={(e) => set("directToolsMode", e.target.value as ServerForm["directToolsMode"])}><option value="off">off</option><option value="all">all (true)</option><option value="list">whitelist</option></select></ConfigField></div>
                  {form.directToolsMode === "list" && <div style={{ flex: 1 }}><ConfigField label="directTools whitelist (comma-separated)"><input style={inputStyle} value={form.directToolsList} onChange={(e) => set("directToolsList", e.target.value)} /></ConfigField></div>}
                  <div style={{ flex: 1 }}><ConfigField label="includeTools (comma-separated)"><input style={inputStyle} value={form.includeTools} onChange={(e) => set("includeTools", e.target.value)} /></ConfigField></div>
                  <div style={{ flex: 1 }}><ConfigField label="excludeTools (comma-separated)"><input style={inputStyle} value={form.excludeTools} onChange={(e) => set("excludeTools", e.target.value)} /></ConfigField></div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ConfigButton size="small" onClick={() => setShowAdvanced((v) => !v)}>{showAdvanced ? t("收起调试") : t("调试")}</ConfigButton>
                  {showAdvanced && (<label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer" }}><input type="checkbox" checked={form.debug} onChange={(e) => set("debug", e.target.checked)} /> debug (show stderr)</label>)}
                </div>
              </>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      {/* Footer：状态 + 右下角操作（与模型页一致） */}
      <ConfigFooter status={
        <>
          {formError && <span style={{ color: "#ef4444" }}>{formError}</span>}
          {formMsg && !formError && <span style={{ color: "var(--accent)" }}>{formMsg}</span>}
        </>
      }>
        {showForm && (
          <>
            <ConfigButton onClick={() => void probeOne(creating ? form.name : originalName, creating ? form.scope : originalScope)} disabled={probingAll}>{t("探测")}</ConfigButton>
            <ConfigButton variant="primary" onClick={save} disabled={saving}>{saving ? t("保存中…") : creating ? t("创建") : t("保存")}</ConfigButton>
          </>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
