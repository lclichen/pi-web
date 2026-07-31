"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebPreferences, McpServerInfo, AgentInfo } from "@/lib/api-types";

interface Props {
  cwd: string;
  sessionId: string | null;
  hasLabTraining: boolean;
  onSendCommand: (command: string) => void;
  onApplyPreferences: (action?: "reload_agents") => void;
  disabled?: boolean;
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    height: 24,
    padding: "0 10px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: active ? "var(--accent)" : "var(--bg-panel)",
    color: active ? "#fff" : "var(--text-muted)",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 4,
    opacity: undefined,
    userSelect: "none",
    transition: "background 0.12s, color 0.12s",
    whiteSpace: "nowrap",
  };
}

const iconStyle: React.CSSProperties = { display: "flex", alignItems: "center" };

function useClickOutside<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);
  return ref;
}

function Popover({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useClickOutside<HTMLDivElement>(onClose);
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        marginBottom: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        zIndex: 100,
        minWidth: 220,
        maxWidth: 320,
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

function ToggleRow({
  name,
  description,
  enabled,
  badge,
  onToggle,
}: {
  name: string;
  description?: string;
  enabled: boolean;
  badge?: string;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        cursor: "pointer",
        borderBottom: "1px solid var(--border)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{
        width: 14, height: 14, borderRadius: 3,
        border: `1.5px solid ${enabled ? "var(--accent)" : "var(--text-dim)"}`,
        background: enabled ? "var(--accent)" : "transparent",
        flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {enabled && (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5">
            <path d="M3 8l3.5 3.5L13 4" />
          </svg>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </div>
        {description && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {description}
          </div>
        )}
      </div>
      {badge && (
        <span style={{
          fontSize: 9, color: "var(--text-dim)",
          padding: "1px 5px", borderRadius: 8,
          border: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          {badge}
        </span>
      )}
    </div>
  );
}

export function SessionToolbar({ cwd, sessionId, hasLabTraining, onSendCommand, onApplyPreferences, disabled }: Props) {
  const [prefs, setPrefs] = useState<WebPreferences>({ mcpEnabled: true, subagentsEnabled: true, labVerifyEnabled: true });
  const [mcpOpen, setMcpOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    fetch(`/api/preferences?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((p: WebPreferences) => setPrefs(p))
      .catch(() => {});
  }, [cwd]);

  const loadMcp = useCallback(() => {
    fetch(`/api/mcp?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { servers: McpServerInfo[] }) => setMcpServers(d.servers ?? []))
      .catch(() => {});
  }, [cwd]);

  const loadAgents = useCallback(() => {
    fetch(`/api/agents?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { agents: AgentInfo[] }) => setAgents(d.agents ?? []))
      .catch(() => {});
  }, [cwd]);

  useEffect(() => {
    loadMcp();
    loadAgents();
  }, [loadMcp, loadAgents]);

  const savePref = useCallback(
    async (key: keyof WebPreferences, value: boolean) => {
      const next = { ...prefs, [key]: value };
      setPrefs(next);
      try {
        await fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, ...next }),
        });
        if (key === "labVerifyEnabled" && sessionId) {
          onSendCommand("/lab verify");
        }
        if (key === "mcpEnabled" || key === "subagentsEnabled") {
          onApplyPreferences();
        }
      } catch {
        /* ignore */
      }
    },
    [cwd, prefs, sessionId, onSendCommand, onApplyPreferences],
  );

  const toggleMcpServer = useCallback(
    async (name: string, scope: string, currentlyDisabled: boolean) => {
      try {
        await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, scope, disabled: !currentlyDisabled }),
        });
        loadMcp();
        onApplyPreferences();
      } catch { /* ignore */ }
    },
    [cwd, loadMcp, onApplyPreferences],
  );

  const toggleAgent = useCallback(
    async (name: string, scope: string, currentlyEnabled: boolean) => {
      try {
        await fetch(`/api/agents/${encodeURIComponent(name)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, scope, enabled: !currentlyEnabled }),
        });
        loadAgents();
        onApplyPreferences("reload_agents");
      } catch { /* ignore */ }
    },
    [cwd, loadAgents, onApplyPreferences],
  );

  const buttons: React.ReactNode[] = [];

  const mcpEnabledCount = mcpServers.filter((s) => !s.disabled).length;
  buttons.push(
    <div key="mcp" style={{ position: "relative" }}>
      <button
        onClick={() => { setMcpOpen((v) => !v); setAgentsOpen(false); }}
        disabled={disabled}
        style={chipStyle(prefs.mcpEnabled)}
      >
        MCP {mcpServers.length > 0 && `(${mcpEnabledCount}/${mcpServers.length})`}
      </button>
      {mcpOpen && (
        <Popover onClose={() => setMcpOpen(false)}>
          <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={prefs.mcpEnabled}
                onChange={(e) => savePref("mcpEnabled", e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              Enable All MCP
            </label>
          </div>
          {mcpServers.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              No MCP servers configured
            </div>
          ) : (
            mcpServers.map((s) => (
              <ToggleRow
                key={`${s.scope}/${s.name}`}
                name={s.name}
                description={s.summary}
                enabled={prefs.mcpEnabled && !s.disabled}
                badge={s.transport}
                onToggle={() => toggleMcpServer(s.name, s.scope, s.disabled)}
              />
            ))
          )}
        </Popover>
      )}
    </div>,
  );

  const agentList = Array.isArray(agents) ? agents : [];
  const agentEnabledCount = agentList.filter((a) => a.enabled !== false).length;
  buttons.push(
    <div key="subagents" style={{ position: "relative" }}>
      <button
        onClick={() => { setAgentsOpen((v) => !v); setMcpOpen(false); }}
        disabled={disabled}
        style={chipStyle(prefs.subagentsEnabled)}
      >
        Agents {agentList.length > 0 && `(${agentEnabledCount}/${agentList.length})`}
      </button>
      {agentsOpen && (
        <Popover onClose={() => setAgentsOpen(false)}>
          <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={prefs.subagentsEnabled}
                onChange={(e) => savePref("subagentsEnabled", e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              Enable All Agents
            </label>
          </div>
          {agentList.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              No subagents configured
            </div>
          ) : (
            agentList.map((a) => (
              <ToggleRow
                key={`${a.scope}/${a.name}`}
                name={a.name}
                description={a.description}
                enabled={prefs.subagentsEnabled && a.enabled !== false}
                badge={a.isDefault ? "builtin" : a.scope}
                onToggle={() => toggleAgent(a.name, a.scope, a.enabled !== false)}
              />
            ))
          )}
        </Popover>
      )}
    </div>,
  );

  if (buttons.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "4px 0",
        flexWrap: "wrap",
        alignItems: "flex-start",
      }}
    >
      {buttons.map((btn) => btn)}
    </div>
  );
}

export { SessionToolbar as default };
