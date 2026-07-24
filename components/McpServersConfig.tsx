"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type {
  ConfigScope,
  McpConfigDocument,
  McpServerInfo,
  McpSettings,
  McpTool,
  ProbeResult,
  ServerEntry,
} from "@/lib/api-types";

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  padding: "4px 8px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  height: "auto",
  minHeight: 64,
  resize: "vertical",
  lineHeight: 1.5,
  padding: "8px",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 4,
  display: "block",
};

function buttonStyle(primary: boolean): React.CSSProperties {
  return {
    height: 30,
    padding: "0 14px",
    borderRadius: 6,
    border: primary ? "none" : "1px solid var(--border)",
    background: primary ? "var(--accent)" : "var(--bg-panel)",
    color: primary ? "#fff" : "var(--text)",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  };
}

function shortenPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKv(raw: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(raw)) {
    const idx = line.search(sep);
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function kvToString(record: Record<string, string> | undefined, sep: string): string {
  if (!record) return "";
  return Object.entries(record)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

interface ServerForm {
  name: string;
  scope: ConfigScope;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  auth: "none" | "oauth" | "bearer";
  bearerToken: string;
  bearerTokenEnv: string;
  lifecycle: string;
  idleTimeout: string;
  requestTimeoutMs: string;
  exposeResources: boolean;
  directToolsMode: "off" | "all" | "list";
  directToolsList: string;
  excludeTools: string;
  debug: boolean;
}

function emptyServerForm(scope: ConfigScope = "project"): ServerForm {
  return {
    name: "",
    scope,
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    auth: "none",
    bearerToken: "",
    bearerTokenEnv: "",
    lifecycle: "",
    idleTimeout: "",
    requestTimeoutMs: "",
    exposeResources: false,
    directToolsMode: "off",
    directToolsList: "",
    excludeTools: "",
    debug: false,
  };
}

function csvToText(list?: string[]): string {
  return list && list.length ? list.join(", ") : "";
}

function entryToForm(name: string, scope: ConfigScope, entry: ServerEntry): ServerForm {
  const transport = entry.url ? "http" : "stdio";
  const dt = entry.directTools;
  let directToolsMode: ServerForm["directToolsMode"] = "off";
  let directToolsList = "";
  if (dt === true) directToolsMode = "all";
  else if (Array.isArray(dt)) {
    directToolsMode = "list";
    directToolsList = dt.join(", ");
  }
  return {
    name,
    scope,
    transport,
    command: entry.command ?? "",
    args: entry.args?.join("\n") ?? "",
    env: kvToString(entry.env, "="),
    cwd: entry.cwd ?? "",
    url: entry.url ?? "",
    headers: kvToString(entry.headers, ": "),
    auth: entry.auth === "oauth" ? "oauth" : entry.auth === "bearer" ? "bearer" : "none",
    bearerToken: entry.bearerToken ?? "",
    bearerTokenEnv: entry.bearerTokenEnv ?? "",
    lifecycle: entry.lifecycle ?? "",
    idleTimeout: entry.idleTimeout !== undefined ? String(entry.idleTimeout) : "",
    requestTimeoutMs: entry.requestTimeoutMs !== undefined ? String(entry.requestTimeoutMs) : "",
    exposeResources: entry.exposeResources === true,
    directToolsMode,
    directToolsList,
    excludeTools: csvToText(entry.excludeTools),
    debug: entry.debug === true,
  };
}

function formToEntry(form: ServerForm): ServerEntry {
  const entry: ServerEntry = {};
  if (form.transport === "stdio") {
    if (form.command.trim()) entry.command = form.command.trim();
    const args = parseLines(form.args);
    if (args.length) entry.args = args;
    const env = parseKv(form.env, /=/);
    if (Object.keys(env).length) entry.env = env;
    if (form.cwd.trim()) entry.cwd = form.cwd.trim();
  } else {
    if (form.url.trim()) entry.url = form.url.trim();
    const headers = parseKv(form.headers, /:\s*/);
    if (Object.keys(headers).length) entry.headers = headers;
    if (form.auth === "oauth") entry.auth = "oauth";
    else if (form.auth === "bearer") {
      entry.auth = "bearer";
      if (form.bearerToken.trim()) entry.bearerToken = form.bearerToken.trim();
      if (form.bearerTokenEnv.trim()) entry.bearerTokenEnv = form.bearerTokenEnv.trim();
    }
  }
  if (form.lifecycle) entry.lifecycle = form.lifecycle as ServerEntry["lifecycle"];
  if (form.idleTimeout.trim() !== "") {
    const n = Number(form.idleTimeout);
    if (Number.isFinite(n)) entry.idleTimeout = n;
  }
  if (form.requestTimeoutMs.trim() !== "") {
    const n = Number(form.requestTimeoutMs);
    if (Number.isFinite(n)) entry.requestTimeoutMs = n;
  }
  if (form.exposeResources) entry.exposeResources = true;
  if (form.directToolsMode === "all") entry.directTools = true;
  else if (form.directToolsMode === "list") {
    const list = form.directToolsList.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) entry.directTools = list;
  }
  const exclude = form.excludeTools.split(",").map((s) => s.trim()).filter(Boolean);
  if (exclude.length) entry.excludeTools = exclude;
  if (form.debug) entry.debug = true;
  return entry;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      type="button"
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: "pointer",
        background: on ? "var(--accent)" : "var(--border)",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
        }}
      />
    </button>
  );
}

export function McpServersConfig({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
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
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<McpSettings>({});
  const [settingsSaving, setSettingsSaving] = useState(false);

  const servers = useMemo(() => doc?.servers ?? [], [doc]);
  const grouped = useMemo(() => {
    return (["project", "global"] as ConfigScope[])
      .map((scope) => ({ scope, servers: servers.filter((s) => s.scope === scope) }))
      .filter((g) => g.servers.length > 0);
  }, [servers]);

  const loadDoc = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json()) as McpConfigDocument & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDoc(data);
      if (data.settings) setSettingsDraft(data.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadDoc();
  }, [loadDoc]);

  const selectServer = (info: McpServerInfo) => {
    setForm(entryToForm(info.name, info.scope, info.entry));
    setOriginalName(info.name);
    setOriginalScope(info.scope);
    setSelectedKey(`${info.scope}\0${info.name}`);
    setCreating(false);
    setFormError(null);
    setFormMsg(null);
    setProbeResult(null);
    setShowAdvanced(false);
  };

  const startCreate = () => {
    setCreating(true);
    setForm(emptyServerForm("project"));
    setSelectedKey(null);
    setFormError(null);
    setFormMsg(null);
    setProbeResult(null);
    setShowAdvanced(false);
  };

  const set = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    setFormMsg(null);
    const entry = formToEntry(form);
    if (!entry.command && !entry.url) {
      setFormError("A command (stdio) or url (http) is required");
      setSaving(false);
      return;
    }
    try {
      if (creating) {
        if (!form.name.trim()) {
          setFormError("Name is required");
          setSaving(false);
          return;
        }
        const res = await fetch("/api/mcp/servers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, scope: form.scope, name: form.name.trim(), entry }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setOriginalName(form.name.trim());
        setOriginalScope(form.scope);
        setFormMsg("Server created.");
        setCreating(false);
        setSelectedKey(`${form.scope}\0${form.name.trim()}`);
      } else {
        const res = await fetch(`/api/mcp/servers/${encodeURIComponent(originalName)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, scope: originalScope, entry }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setFormMsg("Server saved.");
      }
      await loadDoc();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (creating) return;
    if (!window.confirm(`Delete server "${originalName}"?`)) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(
        `/api/mcp/servers/${encodeURIComponent(originalName)}?cwd=${encodeURIComponent(cwd)}&scope=${originalScope}`,
        { method: "DELETE" },
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSelectedKey(null);
      setForm(emptyServerForm());
      await loadDoc();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const probe = async () => {
    setProbing(true);
    setProbeResult(null);
    const entry = formToEntry(form);
    if (!entry.command && !entry.url) {
      setProbeResult({ tools: [], error: "A command or url is required to probe" });
      setProbing(false);
      return;
    }
    try {
      const res = await fetch("/api/mcp/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry, timeoutMs: 15000 }),
      });
      const result = (await res.json()) as ProbeResult & { error?: string };
      if (!res.ok && result.error && result.tools === undefined) {
        setProbeResult({ tools: [], error: result.error });
      } else {
        setProbeResult(result);
      }
    } catch (err) {
      setProbeResult({ tools: [], error: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbing(false);
    }
  };

  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      const scope = doc?.settingsScope ?? "project";
      const res = await fetch("/api/mcp/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope, settings: settingsDraft }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setFormMsg("Settings saved.");
      await loadDoc();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  const showForm = creating || selectedKey !== null;
  const diagnostics = doc?.diagnostics ?? [];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 920,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "82vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              MCP Servers
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(cwd)}
            </code>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => setShowSettings((v) => !v)}
              style={{ ...buttonStyle(false), height: 28, fontSize: 11 }}
            >
              {showSettings ? "Hide" : "Settings"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: "2px 6px",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {showSettings && (
          <div
            style={{
              padding: "12px 18px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "flex-end",
            }}
          >
            <div style={{ width: 150 }}>
              <Field label="toolPrefix">
                <select
                  style={inputStyle}
                  value={settingsDraft.toolPrefix ?? ""}
                  onChange={(e) =>
                    setSettingsDraft((s) => ({
                      ...s,
                      toolPrefix: (e.target.value || undefined) as McpSettings["toolPrefix"],
                    }))
                  }
                >
                  <option value="">(default)</option>
                  <option value="server">server</option>
                  <option value="none">none</option>
                  <option value="short">short</option>
                </select>
              </Field>
            </div>
            <div style={{ width: 120 }}>
              <Field label="idleTimeout (min)">
                <input
                  style={inputStyle}
                  value={settingsDraft.idleTimeout ?? ""}
                  onChange={(e) =>
                    setSettingsDraft((s) => ({
                      ...s,
                      idleTimeout: e.target.value === "" ? undefined : Number(e.target.value),
                    }))
                  }
                />
              </Field>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Toggle
                on={settingsDraft.directTools === true}
                onChange={(v) => setSettingsDraft((s) => ({ ...s, directTools: v || undefined }))}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>directTools</span>
            </div>
            <button onClick={saveSettings} disabled={settingsSaving} style={buttonStyle(true)}>
              {settingsSaving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        )}

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: isMobile ? "100%" : 250,
              maxHeight: isMobile ? "34vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ padding: "8px 8px 4px" }}>
              <button onClick={startCreate} style={{ ...buttonStyle(true), width: "100%" }}>
                + New Server
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px 8px" }}>
              {diagnostics
                .filter((d) => d.parseError)
                .map((d) => (
                  <div
                    key={`diag-${d.scope}`}
                    style={{ padding: "4px 8px", fontSize: 10, color: "#ef4444" }}
                    title={d.parseError}
                  >
                    {d.scope}: invalid JSON
                  </div>
                ))}
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  Loading...
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>{error}</div>
              ) : servers.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  No MCP servers configured.
                </div>
              ) : (
                grouped.map((group) => (
                  <div key={group.scope} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        padding: "4px 8px 3px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                      }}
                    >
                      {group.scope}
                    </div>
                    {group.servers.map((srv) => {
                      const key = `${srv.scope}\0${srv.name}`;
                      const isSelected = !creating && selectedKey === key;
                      return (
                        <button
                          key={key}
                          onClick={() => selectServer(srv)}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 8px",
                            borderRadius: 5,
                            border: "none",
                            background: isSelected ? "var(--bg-selected)" : "transparent",
                            color: isSelected ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer",
                            marginBottom: 1,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: isSelected ? 600 : 400,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 9,
                                padding: "1px 5px",
                                borderRadius: 3,
                                background: srv.transport === "http" ? "#2563eb33" : "#16a34a33",
                                color: srv.transport === "http" ? "#60a5fa" : "#4ade80",
                              }}
                            >
                              {srv.transport}
                            </span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {srv.name}
                            </span>
                            {srv.directToolsOn && (
                              <span style={{ fontSize: 9, color: "var(--accent)" }}>DT</span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--text-dim)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {srv.summary}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {!showForm ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 12,
                }}
              >
                Select a server or create a new one.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Field label="Name">
                      <input
                        style={inputStyle}
                        value={form.name}
                        disabled={!creating}
                        onChange={(e) => set("name", e.target.value)}
                        placeholder="e.g. filesystem"
                      />
                    </Field>
                  </div>
                  <div style={{ width: 130 }}>
                    <Field label="Scope">
                      <select
                        style={inputStyle}
                        value={form.scope}
                        disabled={!creating}
                        onChange={(e) => set("scope", e.target.value as ConfigScope)}
                      >
                        <option value="project">project</option>
                        <option value="global">global</option>
                      </select>
                    </Field>
                  </div>
                  <div style={{ width: 120 }}>
                    <Field label="Connection">
                      <select
                        style={inputStyle}
                        value={form.transport}
                        onChange={(e) => set("transport", e.target.value as "stdio" | "http")}
                      >
                        <option value="stdio">stdio</option>
                        <option value="http">http</option>
                      </select>
                    </Field>
                  </div>
                </div>

                {form.transport === "stdio" ? (
                  <>
                    <Field label="Command">
                      <input
                        style={inputStyle}
                        value={form.command}
                        onChange={(e) => set("command", e.target.value)}
                        placeholder="e.g. npx"
                      />
                    </Field>
                    <Field label="Args (one per line)">
                      <textarea
                        style={textareaStyle}
                        value={form.args}
                        onChange={(e) => set("args", e.target.value)}
                        placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/tmp"}
                      />
                    </Field>
                    <Field label="Env (KEY=VALUE per line)">
                      <textarea
                        style={textareaStyle}
                        value={form.env}
                        onChange={(e) => set("env", e.target.value)}
                        placeholder={"API_KEY=xxx"}
                      />
                    </Field>
                    <Field label="Working directory">
                      <input
                        style={inputStyle}
                        value={form.cwd}
                        onChange={(e) => set("cwd", e.target.value)}
                        placeholder="(optional)"
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="URL">
                      <input
                        style={inputStyle}
                        value={form.url}
                        onChange={(e) => set("url", e.target.value)}
                        placeholder="https://example.com/mcp"
                      />
                    </Field>
                    <Field label="Headers (KEY: VALUE per line)">
                      <textarea
                        style={textareaStyle}
                        value={form.headers}
                        onChange={(e) => set("headers", e.target.value)}
                        placeholder={"X-Custom: value"}
                      />
                    </Field>
                    <div style={{ display: "flex", gap: 12 }}>
                      <div style={{ width: 130 }}>
                        <Field label="Auth">
                          <select
                            style={inputStyle}
                            value={form.auth}
                            onChange={(e) => set("auth", e.target.value as ServerForm["auth"])}
                          >
                            <option value="none">none</option>
                            <option value="bearer">bearer</option>
                            <option value="oauth">oauth</option>
                          </select>
                        </Field>
                      </div>
                      {form.auth === "bearer" && (
                        <>
                          <div style={{ flex: 1 }}>
                            <Field label="Bearer token">
                              <input
                                style={inputStyle}
                                value={form.bearerToken}
                                onChange={(e) => set("bearerToken", e.target.value)}
                                placeholder="(literal token)"
                              />
                            </Field>
                          </div>
                          <div style={{ flex: 1 }}>
                            <Field label="...or env var name">
                              <input
                                style={inputStyle}
                                value={form.bearerTokenEnv}
                                onChange={(e) => set("bearerTokenEnv", e.target.value)}
                                placeholder="e.g. MCP_TOKEN"
                              />
                            </Field>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}

                <button
                  onClick={() => setShowAdvanced((v) => !v)}
                  style={{
                    ...buttonStyle(false),
                    height: 26,
                    fontSize: 11,
                    alignSelf: "flex-start",
                  }}
                >
                  {showAdvanced ? "Hide advanced" : "Advanced options"}
                </button>

                {showAdvanced && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                      padding: 12,
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--bg-panel)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 12 }}>
                      <div style={{ width: 150 }}>
                        <Field label="lifecycle">
                          <select
                            style={inputStyle}
                            value={form.lifecycle}
                            onChange={(e) => set("lifecycle", e.target.value)}
                          >
                            <option value="">(default)</option>
                            <option value="keep-alive">keep-alive</option>
                            <option value="lazy">lazy</option>
                            <option value="eager">eager</option>
                          </select>
                        </Field>
                      </div>
                      <div style={{ width: 140 }}>
                        <Field label="idleTimeout (min)">
                          <input
                            style={inputStyle}
                            value={form.idleTimeout}
                            onChange={(e) => set("idleTimeout", e.target.value)}
                          />
                        </Field>
                      </div>
                      <div style={{ width: 150 }}>
                        <Field label="requestTimeoutMs">
                          <input
                            style={inputStyle}
                            value={form.requestTimeoutMs}
                            onChange={(e) => set("requestTimeoutMs", e.target.value)}
                          />
                        </Field>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Toggle on={form.exposeResources} onChange={(v) => set("exposeResources", v)} />
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>exposeResources</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Toggle on={form.debug} onChange={(v) => set("debug", v)} />
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>debug</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 12 }}>
                      <div style={{ width: 150 }}>
                        <Field label="directTools">
                          <select
                            style={inputStyle}
                            value={form.directToolsMode}
                            onChange={(e) =>
                              set("directToolsMode", e.target.value as ServerForm["directToolsMode"])
                            }
                          >
                            <option value="off">off</option>
                            <option value="all">all (true)</option>
                            <option value="list">whitelist</option>
                          </select>
                        </Field>
                      </div>
                      {form.directToolsMode === "list" && (
                        <div style={{ flex: 1 }}>
                          <Field label="directTools whitelist (comma-separated)">
                            <input
                              style={inputStyle}
                              value={form.directToolsList}
                              onChange={(e) => set("directToolsList", e.target.value)}
                              placeholder="tool_a, tool_b"
                            />
                          </Field>
                        </div>
                      )}
                    </div>
                    <Field label="excludeTools (comma-separated)">
                      <input
                        style={inputStyle}
                        value={form.excludeTools}
                        onChange={(e) => set("excludeTools", e.target.value)}
                        placeholder="tool_a, tool_b"
                      />
                    </Field>
                  </div>
                )}

                {formError && (
                  <div style={{ fontSize: 11, color: "#ef4444" }}>{formError}</div>
                )}
                {formMsg && !formError && (
                  <div style={{ fontSize: 11, color: "var(--accent)" }}>{formMsg}</div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  <button onClick={save} disabled={saving} style={buttonStyle(true)}>
                    {saving ? "Saving..." : creating ? "Create" : "Save"}
                  </button>
                  <button onClick={probe} disabled={probing} style={buttonStyle(false)}>
                    {probing ? "Probing..." : "Probe tools"}
                  </button>
                  {!creating && (
                    <button onClick={remove} disabled={saving} style={buttonStyle(false)}>
                      Delete
                    </button>
                  )}
                </div>

                {probeResult && (
                  <div
                    style={{
                      marginTop: 4,
                      padding: 10,
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--bg-panel)",
                    }}
                  >
                    {probeResult.error && (
                      <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 6 }}>
                        {probeResult.needsAuth
                          ? `Authentication required: ${probeResult.error}`
                          : probeResult.error}
                      </div>
                    )}
                    {probeResult.tools.length > 0 ? (
                      <>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--text-muted)",
                            marginBottom: 6,
                          }}
                        >
                          {probeResult.tools.length} tool
                          {probeResult.tools.length === 1 ? "" : "s"} detected
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {probeResult.tools.map((tool: McpTool) => (
                            <div key={tool.name} style={{ fontSize: 11 }}>
                              <code
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  color: "var(--accent)",
                                }}
                              >
                                {form.name || "server"}_{tool.name}
                              </code>
                              {tool.description && (
                                <span style={{ color: "var(--text-dim)" }}>
                                  {" — "}
                                  {tool.description.slice(0, 120)}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      !probeResult.error && (
                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          No tools exposed by this server.
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
