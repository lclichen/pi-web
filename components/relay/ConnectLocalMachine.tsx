"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelayAgent } from "@/hooks/useRelayAgent";
import type { MachineStatus } from "@/lib/relay/protocol";
import { LocalMachinePanel } from "./LocalMachinePanel";

interface Pairing {
  code: string;
  expiresAt: number;
  relayPort: number;
}

// Renders the top-bar "Connect Local Machine" button (with an online dot) and,
// when clicked, a machine-management modal: list every paired machine
// (multi-machine), rename/unpair them, pair additional machines, and open the
// file/command panel on any of them. Mirrors the Style A modal pattern.
//
// `embedded` renders the pairing content INLINE (no top-bar button, no fixed
// overlay) — used by the remote-connect wizard's pairing step, which needs
// the actual pairing instructions inside the wizard body.
export function ConnectLocalMachine({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n();
  const { online, info, machines, relayPort, advertiseUrl, ready, refresh } = useRelayAgent();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<{ machineId: string } | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairSectionOpen, setPairSectionOpen] = useState(false);
  const [busyMachine, setBusyMachine] = useState<string | null>(null);
  // Bump to re-read status after the agent's workspace root changes.
  const [wsRefresh, setWsRefresh] = useState(0);

  const machinesList = machines ?? [];

  // Mint a fresh pairing code when the modal opens and no agent is connected
  // (or when the user starts pairing ANOTHER machine).
  useEffect(() => {
    if ((!open && !embedded) || (online && !pairSectionOpen)) {
      setPairing(null);
      return;
    }
    let stopped = false;
    const fetchCode = async () => {
      setPairingLoading(true);
      try {
        const res = await fetch("/api/agent-relay/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          ...(pairingLabel.trim() ? { body: JSON.stringify({ label: pairingLabel.trim() }) } : {}),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Pairing;
        if (!stopped) setPairing(data);
      } catch {
        // ignore
      } finally {
        if (!stopped) setPairingLoading(false);
      }
    };
    void fetchCode();
    return () => { stopped = true; };
  }, [open, online, pairSectionOpen, pairingLabel, embedded]);

  const port = pairing?.relayPort ?? relayPort;
  const hasWindow = typeof window !== "undefined";
  const serverUrl = advertiseUrl ?? (hasWindow ? `${window.location.protocol}//${window.location.hostname}:${port}` : "");
  const asset = detectAgentAsset();
  const downloadUrl = hasWindow ? `${window.location.origin}/api/agent-relay/download/${asset.file}` : "";

  const renameMachine = async (m: MachineStatus) => {
    const next = window.prompt("新的机器名称", m.label);
    if (!next || !next.trim() || next.trim() === m.label) return;
    setBusyMachine(m.machineId);
    try {
      await fetch(`/api/agent-relay/machines/${encodeURIComponent(m.machineId)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: next.trim() }),
      });
      refresh();
    } finally {
      setBusyMachine(null);
    }
  };

  const unpairMachine = async (m: MachineStatus) => {
    if (!window.confirm(`解绑「${m.label}」？该机器的 Agent 将立即断开且无法重连（需重新配对）。`)) return;
    setBusyMachine(m.machineId);
    try {
      await fetch(`/api/agent-relay/machines/${encodeURIComponent(m.machineId)}/unpair`, { method: "POST" });
      refresh();
    } finally {
      setBusyMachine(null);
    }
  };

  if (embedded) {
    return (
      <div style={{ padding: 14, height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
        {online && info ? (
          <div style={{ padding: 0 }}>
            <div style={{ color: "#22c55e", fontSize: 13, marginBottom: 12 }}>{t("✓ 已连接")}</div>
            <Row label={t("主机名")} value={info.hostname} />
            <Row label={t("系统")} value={`${info.os} / ${info.arch}`} />
            <Row label={t("工作目录")} value={info.workspaceRoot} />
            <Row label={t("Agent 版本")} value={info.agentVersion} />
          </div>
        ) : (
          <div style={{ padding: 0 }}>
            <p style={{ ...muted, marginTop: 0 }}>
              {t("在你的本地机器（如 CentOS 7）上运行以下命令，把 pi-web 连接到该机器的文件系统与命令行。")}
            </p>
            <PairingSteps
              asset={asset}
              downloadUrl={downloadUrl}
              serverUrl={serverUrl}
              pairing={pairing}
              pairingLoading={pairingLoading}
              label={pairingLabel}
              onLabelChange={setPairingLabel}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={online ? t("已连接：{host} ({os}/{arch})", { host: info?.hostname ?? "", os: info?.os ?? "", arch: info?.arch ?? "" }) : t("连接本地机器")}
        style={{
          display: "flex", alignItems: "center", gap: 6, height: "100%",
          padding: "0 12px", background: "none",
          border: "none", borderTop: "2px solid transparent", borderRight: "1px solid var(--border)",
          color: online ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 11,
          whiteSpace: "nowrap", flexShrink: 0,
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = online ? "var(--text)" : "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: ready ? (online ? "#22c55e" : "#9ca3af") : "#6b7280",
          boxShadow: online ? "0 0 6px #22c55e" : "none",
        }} />
        <span>{online ? t("本地机器") : t("连接本地机器")}</span>
        {machinesList.length > 1 && (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>×{machinesList.length}</span>
        )}
      </button>

      {open && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          style={{
            // Above the remote-connect wizard (1180) — this component is
            // embedded in its pairing step and the dialog must cover it.
            position: "fixed", inset: 0, zIndex: 1200, display: "flex",
            alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)",
          }}
        >
          <div role="dialog" aria-modal="true" style={dialogStyle}>
            <div style={headerStyle}>
              <span style={{ fontWeight: 600 }}>{t("本地机器")}</span>
              <button onClick={() => setOpen(false)} style={closeBtnStyle}>×</button>
            </div>

            <div style={{ padding: 16 }}>
              {machinesList.length > 0 ? (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                    {t("已配对的机器")}（{machinesList.length}）
                  </div>
                  {machinesList.map((m) => (
                    <div key={m.machineId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                        background: m.online ? "#22c55e" : "#9ca3af",
                        boxShadow: m.online ? "0 0 6px #22c55e" : "none",
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {m.label}
                          {m.online && m.info && (
                            <span style={{ ...muted, fontSize: 11, fontFamily: "var(--font-mono)" }}>
                              {" "}{m.info.hostname} · {m.info.os}/{m.info.arch}
                            </span>
                          )}
                        </div>
                        <div style={{ ...muted, fontSize: 11 }}>
                          {m.online
                            ? (m.info?.workspaceRoot ?? "")
                            : `离线${m.lastSeenAt ? ` · 上次在线 ${new Date(m.lastSeenAt).toLocaleString()}` : ""}`}
                        </div>
                      </div>
                      <button
                        disabled={!m.online || busyMachine === m.machineId}
                        onClick={() => { setOpen(false); setPanel({ machineId: m.machineId }); }}
                        style={{ ...secondaryBtnStyle, opacity: m.online ? 1 : 0.5 }}
                      >
                        {t("面板")}
                      </button>
                      {m.online && m.info && (
                        <WorkspaceRootEditor
                          current={m.info.workspaceRoot}
                          machineId={m.machineId}
                          onSaved={() => setWsRefresh((k) => k + 1)}
                        />
                      )}
                      <button
                        disabled={busyMachine === m.machineId}
                        onClick={() => void renameMachine(m)}
                        style={{ ...closeBtnStyle, fontSize: 13 }}
                        title={t("重命名")}
                      >
                        ✎
                      </button>
                      <button
                        disabled={busyMachine === m.machineId}
                        onClick={() => void unpairMachine(m)}
                        style={{ ...closeBtnStyle, fontSize: 13, color: "#ef4444" }}
                        title={t("解绑")}
                      >
                        ⨯
                      </button>
                    </div>
                  ))}
                </>
              ) : (
                <p style={{ ...muted, marginTop: 0 }}>
                  {t("在你的本地机器（如 CentOS 7）上运行以下命令，把 pi-web 连接到该机器的文件系统与命令行。")}
                </p>
              )}

              <div style={{ marginTop: 12, borderTop: machinesList.length > 0 ? "1px solid var(--border)" : "none", paddingTop: 12 }}>
                <button onClick={() => { setPairSectionOpen((v) => !v); setPairing(null); }} style={secondaryBtnStyle}>
                  {pairSectionOpen ? t("收起配对") : t("＋ 配对新机器")}
                </button>
                {pairSectionOpen && (
                  <div style={{ marginTop: 10 }}>
                    <PairingSteps
                      asset={asset}
                      downloadUrl={downloadUrl}
                      serverUrl={serverUrl}
                      pairing={pairing}
                      pairingLoading={pairingLoading}
                      label={pairingLabel}
                      onLabelChange={setPairingLabel}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {panel && (
        <LocalMachinePanel
          machineId={panel.machineId}
          machines={machinesList}
          onSelectMachine={setPanel}
          onClose={() => setPanel(null)}
        />
      )}
    </>
  );
}

/** Shared pairing instructions (label input + code + download/command). */
function PairingSteps({
  asset, downloadUrl, serverUrl, pairing, pairingLoading, label, onLabelChange,
}: {
  asset: { file: string; label: string };
  downloadUrl: string;
  serverUrl: string;
  pairing: Pairing | null;
  pairingLoading: boolean;
  label: string;
  onLabelChange: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Step n={1} title={t("下载 Agent")}>
        <CodeBlock code={`curl -fsSL -o pi-agent ${downloadUrl}\nchmod +x pi-agent`} />
        <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
          检测到 {asset.label}；其它架构请在 URL 里替换文件名（linux-arm64 / windows-amd64.exe）。
        </div>
      </Step>
      <Step n={2} title="配对">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ ...muted, fontSize: 11, flexShrink: 0 }}>机器名称</span>
          <input
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="如：工位机 / 实验室服务器（可选）"
            maxLength={50}
            style={{ flex: 1, padding: "4px 8px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 12 }}
          />
        </div>
        {pairingLoading && <div style={muted}>生成配对码…</div>}
        {!pairingLoading && !pairing && <div style={{ ...muted, color: "#ef4444" }}>无法生成配对码，请稍后重试。</div>}
        {pairing && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <span style={codeStyle}>{pairing.code}</span>
              <span style={{ ...muted, fontSize: 11 }}>有效期 5 分钟</span>
            </div>
            <CodeBlock code={`./pi-agent pair --code ${pairing.code} --server ${serverUrl}${label.trim() ? ` --label ${label.trim()}` : ""}`} />
          </>
        )}
      </Step>
      <Step n={3} title="（可选）后台常驻">
        <CodeBlock code={"nohup ./pi-agent run >pi-agent.log 2>&1 &\n# 或 systemd: 见 agent/contrib/pi-agent.service"} />
      </Step>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={spinStyle} />
        <span style={muted}>等待 Agent 连接…（连接成功后自动继续）</span>
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 12 }}>
        提示：若 Agent 与浏览器不在同一台机器，请用 pi-web 服务器的实际地址，
        或在服务端设置环境变量 <code>PI_RELAY_ADVERTISE_URL</code>。
      </p>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)", width: 80, flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

/** 更改本机工作区目录：调 agent 的 workspace.set-root（校验→持久化到
 *  ~/.pi-agent/config.json→热切换并重发 hello）。仅 v0.1.2+ agent 支持。 */
function WorkspaceRootEditor({ current, machineId, onSaved }: { current?: string; machineId?: string; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", gap: 8, padding: "3px 0", alignItems: "center" }}>
      <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>更改目录</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const next = window.prompt("新的工作区绝对路径（影响所有本机会话）：", current ?? "");
          if (!next || !next.trim() || next.trim() === current) return;
          setBusy(true);
          setMsg(null);
          import("@/lib/relay-client").then(({ relaySetWorkspaceRoot }) =>
            relaySetWorkspaceRoot(next.trim(), machineId ? { machineId } : undefined)
              .then(() => { setMsg("已更改"); onSaved(); })
              .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false)),
          );
        }}
        style={{ height: 24, padding: "0 10px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 11, cursor: busy ? "default" : "pointer" }}
      >
        {busy ? "应用中…" : "更改…"}
      </button>
      {msg && <span style={{ fontSize: 11, color: msg === "已更改" ? "#22c55e" : "#f87171" }}>{msg}</span>}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{n}. {title}</div>
      {children}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <div style={{ position: "relative" }}>
      <pre style={{
        margin: 0, padding: "8px 32px 8px 10px", background: "var(--bg)",
        border: "1px solid var(--border)", borderRadius: 4, overflow: "auto",
        fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-all",
      }}>
        {code}
      </pre>
      <button onClick={copy} style={{ ...closeBtnStyle, position: "absolute", top: 4, right: 4, fontSize: 10 }}>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

function detectAgentAsset(): { file: string; label: string } {
  if (typeof navigator === "undefined") return { file: "pi-agent-linux-amd64", label: "Linux x86_64" };
  const ua = navigator.userAgent.toLowerCase();
  const isArm = /aarch64|arm64|armv8/.test(ua);
  if (/mac/.test(ua)) return { file: "pi-agent-linux-amd64", label: "macOS（请用 Linux 版在目标机上运行）" };
  if (/win/.test(ua)) return { file: "pi-agent-windows-amd64.exe", label: "Windows x86_64" };
  return { file: isArm ? "pi-agent-linux-arm64" : "pi-agent-linux-amd64", label: isArm ? "Linux arm64" : "Linux x86_64" };
}

const dialogStyle: React.CSSProperties = {
  width: "min(560px, 94vw)", maxHeight: "90vh", overflow: "auto",
  background: "var(--bg-panel)", border: "1px solid var(--border)",
  borderRadius: 8, boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
};
const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "10px 14px", borderBottom: "1px solid var(--border)",
};
const closeBtnStyle: React.CSSProperties = {
  background: "transparent", border: "none", color: "var(--text-muted)",
  cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 6px",
};
const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 700, letterSpacing: 4,
  color: "var(--accent)", background: "var(--bg)", padding: "4px 12px", borderRadius: 4,
  border: "1px solid var(--border)",
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
  background: "var(--accent)", color: "#fff", border: "none", borderRadius: 4,
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 14px", fontSize: 12, cursor: "pointer",
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4,
};
const muted: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)" };
const spinStyle: React.CSSProperties = {
  width: 12, height: 12, borderRadius: "50%",
  border: "2px solid var(--border)", borderTopColor: "var(--accent)",
  display: "inline-block", animation: "spin 0.8s linear infinite",
};
