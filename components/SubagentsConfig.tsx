"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { AgentDetail, AgentInfo, ConfigScope } from "@/lib/api-types";

const THINKING_OPTIONS = ["off", "low", "medium", "high"];

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
  minHeight: 120,
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

interface AgentForm {
  name: string;
  scope: ConfigScope;
  description: string;
  tools: string;
  disallowedTools: string;
  model: string;
  thinking: string;
  maxTurns: string;
  systemPrompt: string;
}

function csvToForm(list?: string[]): string {
  return list && list.length ? list.join(", ") : "";
}

function emptyForm(scope: ConfigScope = "project"): AgentForm {
  return {
    name: "",
    scope,
    description: "",
    tools: "",
    disallowedTools: "",
    model: "",
    thinking: "off",
    maxTurns: "",
    systemPrompt: "",
  };
}

function detailToForm(detail: AgentDetail): AgentForm {
  return {
    name: detail.name,
    scope: detail.scope,
    description: detail.description ?? "",
    tools: csvToForm(detail.tools),
    disallowedTools: csvToForm(detail.disallowedTools),
    model: detail.model ?? "",
    thinking: detail.thinking ?? "off",
    maxTurns: detail.maxTurns !== undefined ? String(detail.maxTurns) : "",
    systemPrompt: detail.systemPrompt,
  };
}

function parseCsv(s: string): string[] {
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  return parts;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export function SubagentsConfig({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
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

  const grouped = useMemo(() => {
    return (["project", "global"] as ConfigScope[])
      .map((scope) => ({
        scope,
        agents: agents.filter((a) => a.scope === scope),
      }))
      .filter((g) => g.agents.length > 0);
  }, [agents]);

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

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(
    async (name: string, scope: ConfigScope) => {
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

  const selectAgent = (agent: AgentInfo) => {
    void loadDetail(agent.name, agent.scope);
  };

  const startCreate = () => {
    setCreating(true);
    setDetail(null);
    setSelectedKey(null);
    setForm(emptyForm("project"));
    setFormError(null);
    setFormMsg(null);
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    setFormMsg(null);
    const tools = parseCsv(form.tools);
    const disallowedTools = parseCsv(form.disallowedTools);
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
      disallowedTools: disallowedTools.length ? disallowedTools : undefined,
      model: form.model.trim() || undefined,
      thinking: form.thinking || undefined,
      maxTurns: maxTurnsNum,
      systemPrompt: form.systemPrompt,
    };
    try {
      if (creating) {
        if (!form.name.trim()) {
          setFormError("Name is required");
          setSaving(false);
          return;
        }
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, name: form.name.trim() }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setFormMsg("Agent created.");
      } else {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(form.name)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = (await res.json()) as { error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        setFormMsg("Agent saved.");
      }
      await loadList();
      if (creating) {
        await loadDetail(form.name.trim(), form.scope);
      }
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

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const showForm = creating || detail !== null;

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
          width: isMobile ? "calc(100vw - 16px)" : 880,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "78vh",
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
              Subagents
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
              width: isMobile ? "100%" : 240,
              maxHeight: isMobile ? "36vh" : undefined,
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
                + New Agent
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px 8px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  Loading...
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>
                  {error}
                </div>
              ) : agents.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  No agents defined yet.
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
                    {group.agents.map((agent) => {
                      const key = `${agent.scope}\0${agent.name}`;
                      const isSelected = !creating && selectedKey === key;
                      return (
                        <button
                          key={key}
                          onClick={() => selectAgent(agent)}
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
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {agent.name}
                            </span>
                            {agent.parseError && (
                              <span title={agent.parseError} style={{ color: "#f59e0b", fontSize: 10 }}>
                                !
                              </span>
                            )}
                          </div>
                          {agent.description && (
                            <div
                              style={{
                                fontSize: 10,
                                color: "var(--text-dim)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {agent.description}
                            </div>
                          )}
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
                Select an agent or create a new one.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 620 }}>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Field label="Name">
                      <input
                        style={inputStyle}
                        value={form.name}
                        disabled={!creating}
                        onChange={(e) => set("name", e.target.value)}
                        placeholder="e.g. security-auditor"
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
                </div>

                <Field label="Description">
                  <input
                    style={inputStyle}
                    value={form.description}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder="Short summary of this agent"
                  />
                </Field>

                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Field label="Model">
                      <input
                        style={inputStyle}
                        value={form.model}
                        onChange={(e) => set("model", e.target.value)}
                        placeholder="e.g. anthropic/claude-haiku-4-5"
                      />
                    </Field>
                  </div>
                  <div style={{ width: 130 }}>
                    <Field label="Thinking">
                      <select
                        style={inputStyle}
                        value={form.thinking}
                        onChange={(e) => set("thinking", e.target.value)}
                      >
                        {THINKING_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <Field label="Max turns">
                      <input
                        style={inputStyle}
                        value={form.maxTurns}
                        onChange={(e) => set("maxTurns", e.target.value)}
                        placeholder="e.g. 10 (0 = unlimited)"
                      />
                    </Field>
                  </div>
                </div>

                <Field label="Tools (comma-separated, supports ext:name)">
                  <input
                    style={inputStyle}
                    value={form.tools}
                    onChange={(e) => set("tools", e.target.value)}
                    placeholder="e.g. read, grep, bash, ext:pi-mcp-adapter"
                  />
                </Field>

                <Field label="Disallowed tools (comma-separated)">
                  <input
                    style={inputStyle}
                    value={form.disallowedTools}
                    onChange={(e) => set("disallowedTools", e.target.value)}
                    placeholder="e.g. write, edit"
                  />
                </Field>

                <Field label="System prompt">
                  <textarea
                    style={textareaStyle}
                    value={form.systemPrompt}
                    onChange={(e) => set("systemPrompt", e.target.value)}
                    placeholder="Instructions defining the agent's behavior..."
                  />
                </Field>

                {detail?.parseError && (
                  <div style={{ fontSize: 11, color: "#f59e0b" }}>
                    Parse warning: {detail.parseError}
                  </div>
                )}
                {formError && (
                  <div style={{ fontSize: 11, color: "#ef4444" }}>{formError}</div>
                )}
                {formMsg && (
                  <div style={{ fontSize: 11, color: "var(--accent)" }}>{formMsg}</div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button
                    onClick={save}
                    disabled={saving}
                    style={buttonStyle(true)}
                  >
                    {saving ? "Saving..." : creating ? "Create" : "Save"}
                  </button>
                  {!creating && detail && (
                    <button
                      onClick={remove}
                      disabled={saving}
                      style={buttonStyle(false)}
                    >
                      Delete
                    </button>
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
