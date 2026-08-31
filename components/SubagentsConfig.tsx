"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { AgentDetail, AgentInfo, ConfigScope, McpServerTools, WebPreferences } from "@/lib/api-types";

const THINKING_OPTIONS = ["off", "low", "medium", "high"];
const BUILTIN_DEFAULTS = ["read", "write", "bash", "edit", "find", "grep", "ls"];

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 30,
  padding: "3px 8px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 3,
  display: "block",
};

function buttonStyle(primary: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: "0 12px",
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

interface ToolDiscovery {
  builtin: string[];
  mcp: McpServerTools[];
}

interface AgentForm {
  name: string;
  scope: ConfigScope;
  description: string;
  model: string;
  thinking: string;
  maxTurns: string;
  systemPrompt: string;
  builtinTools: Set<string>;
  mcpAll: boolean;
  mcpTools: Set<string>;
}

function emptyForm(scope: ConfigScope = "project"): AgentForm {
  return {
    name: "",
    scope,
    description: "",
    model: "",
    thinking: "off",
    maxTurns: "",
    systemPrompt: "",
    builtinTools: new Set(BUILTIN_DEFAULTS),
    mcpAll: false,
    mcpTools: new Set(),
  };
}

function detailToForm(detail: AgentDetail): AgentForm {
  const builtin = new Set<string>();
  const mcpTools = new Set<string>();
  let mcpAll = false;
  const tools = detail.tools ?? [];
  for (const t of tools) {
    if (t === "ext:pi-mcp-adapter") {
      mcpAll = true;
    } else if (t.startsWith("ext:pi-mcp-adapter/")) {
      mcpTools.add(t.slice("ext:pi-mcp-adapter/".length));
    } else if (!t.startsWith("ext:")) {
      builtin.add(t);
    } else {
      mcpTools.add(t);
    }
  }
  return {
    name: detail.name,
    // Built-ins have no writable scope; the field is disabled anyway.
    scope: detail.scope === "builtin" ? "project" : detail.scope,
    description: detail.description ?? "",
    model: detail.model ?? "",
    thinking: detail.thinking ?? "off",
    maxTurns: detail.maxTurns !== undefined ? String(detail.maxTurns) : "",
    systemPrompt: detail.systemPrompt,
    builtinTools: builtin,
    mcpAll,
    mcpTools,
  };
}

function formToToolsCsv(form: AgentForm): string[] {
  const parts: string[] = [...form.builtinTools];
  if (form.mcpAll) {
    parts.push("ext:pi-mcp-adapter");
  } else {
    for (const t of form.mcpTools) {
      parts.push(`ext:pi-mcp-adapter/${t}`);
    }
  }
  return parts;
}

function toolsSummary(form: AgentForm): string {
  const builtinCount = form.builtinTools.size;
  const mcpCount = form.mcpAll ? -1 : form.mcpTools.size;
  const parts = [`${builtinCount} builtin`];
  if (mcpCount === -1) parts.push("all MCP");
  else if (mcpCount > 0) parts.push(`${mcpCount} MCP`);
  return parts.join(", ");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function ToolCheckbox({
  checked,
  onChange,
  label,
  sublabel,
  indent,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sublabel?: string;
  indent?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        paddingLeft: indent ? 16 : 0,
        fontSize: 11,
        color: "var(--text)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0, cursor: "pointer" }}
      />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{label}</span>
      {sublabel && (
        <span style={{ color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sublabel}
        </span>
      )}
    </label>
  );
}

export function SubagentsConfig({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const isMobile = useIsMobile();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AgentForm>(emptyForm());
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<ToolDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [showToolPicker, setShowToolPicker] = useState(false);
  const [prefs, setPrefs] = useState<WebPreferences>({ mcpEnabled: true, subagentsEnabled: true, labVerifyEnabled: true });

  const grouped = useMemo(() => {
    return (["builtin", "project", "global"] as const)
      .map((scope) => ({ scope, agents: agents.filter((a) => a.scope === scope) }))
      .filter((g) => g.agents.length > 0);
  }, [agents]);

  // Built-in subagents are served by the API read-only: their definition ships
  // with pi itself (no .md file to edit), so the form renders disabled.
  const readOnly = !creating && detail?.scope === "builtin";

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json()) as { agents?: AgentInfo[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAgents(data.agents ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const loadDiscovery = useCallback(async () => {
    setDiscoveryLoading(true);
    try {
      const res = await fetch(`/api/tools/discover?cwd=${encodeURIComponent(cwd)}&probe=true`);
      const data = (await res.json()) as ToolDiscovery & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDiscovery(data);
    } catch {
      setDiscovery({ builtin: BUILTIN_DEFAULTS, mcp: [] });
    } finally {
      setDiscoveryLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    fetch(`/api/preferences?cwd=${encodeURIComponent(cwd)}`).then(r => r.json()).then((p: WebPreferences) => setPrefs(p)).catch(() => {});
  }, [cwd]);

  const togglePref = async (key: "subagentsEnabled", value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try {
      await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, ...next }) });
    } catch { /* ignore */ }
  };

  const loadDetail = useCallback(
    async (name: string, scope: ConfigScope | "builtin") => {
      setFormError(null);
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}&scope=${scope}`,
        );
        const data = (await res.json()) as AgentDetail & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        setDetail(data);
        setForm(detailToForm(data));
        setCreating(false);
        setSelectedKey(`${scope}\0${name}`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      }
    },
    [cwd],
  );

  const selectAgent = (agent: AgentInfo) => void loadDetail(agent.name, agent.scope);

  const startCreate = () => {
    setCreating(true);
    setDetail(null);
    setSelectedKey(null);
    setForm(emptyForm("project"));
    setFormError(null);
    setFormMsg(null);
  };

  const toggleBuiltin = (tool: string, on: boolean) => {
    setForm((f) => {
      const next = new Set(f.builtinTools);
      if (on) next.add(tool); else next.delete(tool);
      return { ...f, builtinTools: next };
    });
  };

  const toggleMcpTool = (tool: string, on: boolean) => {
    setForm((f) => {
      const next = new Set(f.mcpTools);
      if (on) next.add(tool); else next.delete(tool);
      return { ...f, mcpTools: next, mcpAll: false };
    });
  };

  const toggleAllBuiltin = (on: boolean) => {
    setForm((f) => ({ ...f, builtinTools: on ? new Set(discovery?.builtin ?? BUILTIN_DEFAULTS) : new Set() }));
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    setFormMsg(null);
    const tools = formToToolsCsv(form);
    const maxTurnsNum = form.maxTurns.trim() === "" ? undefined : Number(form.maxTurns);
    if (maxTurnsNum !== undefined && !Number.isFinite(maxTurnsNum)) {
      setFormError("max_turns must be a number");
      setSaving(false);
      return;
    }
    const payload = {
      cwd,
      scope: form.scope,
      description: form.description.trim() || undefined,
      tools: tools.length ? tools : undefined,
      model: form.model.trim() || undefined,
      thinking: form.thinking || undefined,
      maxTurns: maxTurnsNum,
      systemPrompt: form.systemPrompt,
    };
    try {
      if (creating) {
        if (!form.name.trim()) { setFormError("Name is required"); setSaving(false); return; }
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, name: form.name.trim() }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setFormMsg("Agent created.");
      } else {
        const res = await fetch(`/api/agents/${encodeURIComponent(form.name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setFormMsg("Agent saved.");
      }
      await loadList();
      if (creating) await loadDetail(form.name.trim(), form.scope);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!detail || creating) return;
    if (!window.confirm(`Delete agent "${detail.name}"?`)) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(detail.name)}?cwd=${encodeURIComponent(cwd)}&scope=${detail.scope}`,
        { method: "DELETE" },
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setDetail(null);
      setSelectedKey(null);
      setForm(emptyForm());
      await loadList();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const showForm = creating || detail !== null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 920, maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "82vh", maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
          display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Subagents</span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortenPath(cwd)}</code>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer", color: prefs.subagentsEnabled ? "var(--text)" : "var(--text-dim)" }}>
              <input type="checkbox" checked={prefs.subagentsEnabled} onChange={(e) => void togglePref("subagentsEnabled", e.target.checked)} style={{ margin: 0 }} />
              active
            </label>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left: agent list */}
          <div style={{ width: isMobile ? "100%" : 175, maxHeight: isMobile ? "32vh" : undefined, borderRight: isMobile ? "none" : "1px solid var(--border)", borderBottom: isMobile ? "1px solid var(--border)" : "none", display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)" }}>
            <div style={{ padding: "6px 6px 2px" }}>
              <button onClick={startCreate} style={{ ...buttonStyle(true), width: "100%" }}>+ New</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "2px 4px 6px" }}>
              {loading ? <div style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>Loading...</div>
              : error ? <div style={{ padding: "8px", fontSize: 11, color: "#ef4444" }}>{error}</div>
              : agents.length === 0 ? <div style={{ padding: "8px", fontSize: 11, color: "var(--text-dim)" }}>No agents defined.</div>
              : grouped.map((group) => (
                <div key={group.scope} style={{ marginBottom: 4 }}>
                  <div style={{ padding: "3px 6px 2px", fontSize: 9, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>{group.scope === "builtin" ? "built-in" : group.scope}</div>
                  {group.agents.map((agent) => {
                    const key = `${agent.scope}\0${agent.name}`;
                    const isSelected = !creating && selectedKey === key;
                    return (
                      <button key={key} onClick={() => selectAgent(agent)} style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 6px", borderRadius: 4, border: "none", background: isSelected ? "var(--bg-selected)" : "transparent", color: isSelected ? "var(--text)" : "var(--text-muted)", cursor: "pointer", marginBottom: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</div>
                        {agent.description && <div style={{ fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.description}</div>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Right: form */}
          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column" }}>
            {!showForm ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>Select an agent or create a new one.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
                {/* Compact metadata grid */}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 140px" }}>
                    <Field label="Name">
                      <input style={inputStyle} value={form.name} disabled={!creating || readOnly} onChange={(e) => set("name", e.target.value)} placeholder="security-auditor" />
                    </Field>
                  </div>
                  <div style={{ width: 110 }}>
                    <Field label="Scope">
                      <select style={inputStyle} value={form.scope} disabled={!creating || readOnly} onChange={(e) => set("scope", e.target.value as ConfigScope)}>
                        <option value="project">project</option>
                        <option value="global">global</option>
                      </select>
                    </Field>
                  </div>
                  <div style={{ flex: "1 1 160px" }}>
                    <Field label="Description">
                      <input style={inputStyle} value={form.description} disabled={readOnly} onChange={(e) => set("description", e.target.value)} placeholder="Security code reviewer" />
                    </Field>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 160px" }}>
                    <Field label="Model (empty = session default)">
                      <input style={inputStyle} value={form.model} disabled={readOnly} onChange={(e) => set("model", e.target.value)} placeholder="session default" />
                    </Field>
                  </div>
                  <div style={{ width: 100 }}>
                    <Field label="Thinking">
                      <select style={inputStyle} value={form.thinking} disabled={readOnly} onChange={(e) => set("thinking", e.target.value)}>
                        {THINKING_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div style={{ width: 100 }}>
                    <Field label="Max turns (0 = unlimited)">
                      <input style={inputStyle} value={form.maxTurns} disabled={readOnly} onChange={(e) => set("maxTurns", e.target.value)} placeholder="10" />
                    </Field>
                  </div>
                </div>

                {/* Tool picker */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <button onClick={() => { setShowToolPicker((v) => !v); if (!discovery && !discoveryLoading) void loadDiscovery(); }} style={{ ...buttonStyle(false), height: 24, fontSize: 11 }}>
                      {showToolPicker ? "Hide" : "Tools"}: {toolsSummary(form)}
                    </button>
                    {showToolPicker && !discovery && !discoveryLoading && (
                      <button onClick={() => void loadDiscovery()} style={{ ...buttonStyle(false), height: 24, fontSize: 10 }}>Discover MCP</button>
                    )}
                  </div>
                  {showToolPicker && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 8, maxHeight: 200, overflowY: "auto" }}>
                      {discoveryLoading && <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>Discovering tools...</div>}
                      {/* Builtin tools */}
                      {discovery && (
                        <>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>Built-in</span>
                            <button onClick={() => toggleAllBuiltin(discovery.builtin.some((t) => !form.builtinTools.has(t)))} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 10, cursor: "pointer" }}>
                              {discovery.builtin.every((t) => form.builtinTools.has(t)) ? "Clear all" : "Select all"}
                            </button>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 3, marginBottom: 8 }}>
                            {discovery.builtin.map((tool) => (
                              <ToolCheckbox key={tool} checked={form.builtinTools.has(tool)} onChange={(v) => toggleBuiltin(tool, v)} label={tool} />
                            ))}
                          </div>
                          {/* MCP tools */}
                          {discovery.mcp.length > 0 && (
                            <>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, marginTop: 4 }}>
                                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>MCP Tools</span>
                                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer" }}>
                                  <input type="checkbox" checked={form.mcpAll} disabled={readOnly} onChange={(e) => set("mcpAll", e.target.checked)} style={{ margin: 0 }} />
                                  <span style={{ color: "var(--text-muted)" }}>All (ext:pi-mcp-adapter)</span>
                                </label>
                              </div>
                              {!form.mcpAll && discovery.mcp.map((srv) => (
                                <div key={srv.server} style={{ marginBottom: 6 }}>
                                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>{srv.server} {srv.error && <span style={{ color: "#f59e0b" }}>({srv.error.slice(0, 40)})</span>}</div>
                                  {srv.tools.length > 0 ? srv.tools.map((tool) => {
                                    const prefixed = `${srv.server}_${tool.name}`;
                                    return <ToolCheckbox key={prefixed} checked={form.mcpTools.has(prefixed)} onChange={(v) => toggleMcpTool(prefixed, v)} label={prefixed} sublabel={tool.description?.slice(0, 40)} indent />;
                                  }) : !srv.error && <span style={{ fontSize: 10, color: "var(--text-dim)", paddingLeft: 16 }}>No tools</span>}
                                </div>
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* System prompt - gets remaining space */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <label style={labelStyle}>System prompt</label>
                  <textarea
                    style={{ ...inputStyle, flex: 1, minHeight: 160, height: "auto", resize: "none", padding: 8, lineHeight: 1.5 }}
                    value={form.systemPrompt}
                    disabled={readOnly}
                    onChange={(e) => set("systemPrompt", e.target.value)}
                    placeholder="Instructions defining the agent's behavior and constraints..."
                  />
                </div>

                {detail?.parseError && <div style={{ fontSize: 11, color: "#f59e0b" }}>Parse warning: {detail.parseError}</div>}
                {formError && <div style={{ fontSize: 11, color: "#ef4444" }}>{formError}</div>}
                {formMsg && !formError && <div style={{ fontSize: 11, color: "var(--accent)" }}>{formMsg}</div>}

                <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                  {readOnly ? (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Built-in agent — read-only. Create a same-named project agent to override it.</div>
                  ) : (
                    <>
                      <button onClick={save} disabled={saving} style={buttonStyle(true)}>{saving ? "Saving..." : creating ? "Create" : "Save"}</button>
                      {!creating && detail && <button onClick={remove} disabled={saving} style={buttonStyle(false)}>Delete</button>}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
