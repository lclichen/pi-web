"use client";

import { useCallback, useEffect, useState } from "react";
import type { WebPreferences } from "@/lib/api-types";

interface Props {
  cwd: string;
  sessionId: string | null;
  hasLabTraining: boolean;
  onSendCommand: (command: string) => void;
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

export function SessionToolbar({ cwd, sessionId, hasLabTraining, onSendCommand, disabled }: Props) {
  const [prefs, setPrefs] = useState<WebPreferences>({ mcpEnabled: true, subagentsEnabled: true, labVerifyEnabled: true });

  useEffect(() => {
    fetch(`/api/preferences?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((p: WebPreferences) => setPrefs(p))
      .catch(() => {});
  }, [cwd]);

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
      } catch {
        /* ignore */
      }
    },
    [cwd, prefs, sessionId, onSendCommand],
  );

  const buttons: React.ReactNode[] = [];

    if (hasLabTraining) {
      buttons.push(
        <button
          key="lab-start"
          onClick={() => onSendCommand("/lab")}
          disabled={disabled}
          style={{ ...chipStyle(false), borderColor: "var(--accent)", color: "var(--accent)" }}
        >
          <span style={iconStyle}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 3l14 9-14 9V3z" />
            </svg>
          </span>
          Start Lab
        </button>,
      );

      buttons.push(
        <button
          key="lab-verify"
          onClick={() => savePref("labVerifyEnabled", !prefs.labVerifyEnabled)}
          disabled={disabled}
          style={chipStyle(prefs.labVerifyEnabled)}
        >
          {prefs.labVerifyEnabled ? "Verify ON" : "Verify OFF"}
        </button>,
      );
    }

  buttons.push(
    <button
      key="mcp"
      onClick={() => savePref("mcpEnabled", !prefs.mcpEnabled)}
      disabled={disabled}
      style={chipStyle(prefs.mcpEnabled)}
    >
      MCP
    </button>,
  );

  buttons.push(
    <button
      key="subagents"
      onClick={() => savePref("subagentsEnabled", !prefs.subagentsEnabled)}
      disabled={disabled}
      style={chipStyle(prefs.subagentsEnabled)}
    >
      Agents
    </button>,
  );

  if (buttons.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "4px 0",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      {buttons.map((btn) => btn)}
    </div>
  );
}

export { SessionToolbar as default };
