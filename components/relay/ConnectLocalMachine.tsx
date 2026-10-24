"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelayAgent } from "@/hooks/useRelayAgent";
import { clientAssetName, clientCompatibility, REQUIRED_CLIENT_VERSION } from "@/lib/client-compat";
import type { MachineStatus } from "@/lib/relay/protocol";
import { LocalMachinePanel } from "./LocalMachinePanel";

interface Pairing {
  code: string;
  expiresAt: number;
  relayPort: number;
}

// Two exports:
//  - LocalMachinesDialog({ open, onClose }) — the machine-management modal
//    (paired machines, rename/unpair, pair new, file/command panel). Opened
//    from the top-bar "环境" menu (components/EnvironmentsMenu.tsx); the old
//    dedicated top-bar button was consolidated there.
//  - ConnectLocalMachine() — the INLINE pairing content used by the
//    remote-connect wizard's pairing step (no button, no fixed overlay).

/** Install/pair info shared by the dialog and the embedded pairing steps. */
function useAgentInstallInfo() {
  const { relayPort, advertiseUrl } = useRelayAgent();
  const port = relayPort;
  const hasWindow = typeof window !== "undefined";
  const serverUrl = advertiseUrl ?? (hasWindow ? `${window.location.protocol}//${window.location.hostname}:${port}` : "");
  const asset = detectAgentAsset();
  const downloadUrl = hasWindow ? `${window.location.origin}/api/agent-relay/download/${asset.file}` : "";
  return { serverUrl, asset, downloadUrl };
}

export function LocalMachinesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { online, machines, ready, refresh, requiredVersion } = useRelayAgent();
  const { serverUrl, asset, downloadUrl } = useAgentInstallInfo();
  const [panel, setPanel] = useState<{ machineId: string } | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairSectionOpen, setPairSectionOpen] = useState(false);
  const [busyMachine, setBusyMachine] = useState<string | null>(null);

  const machinesList = machines ?? [];
  void ready; // 在线点由菜单按钮展示；对话框内不需要

  // Mint a fresh pairing code while the dialog is open and no agent is
  // connected (or when the user starts pairing ANOTHER machine).
  useEffect(() => {
    if (!open || (online && !pairSectionOpen)) {
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
  }, [open, online, pairSectionOpen]);

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

  if (!open) return null;

  return (
    <>
      <div
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        style={{
          // Above the remote-connect wizard (1180) — the wizard's pairing step
          // shares this module's state and the dialog must cover it.
          position: "fixed", inset: 0, zIndex: 1200, display: "flex",
          alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)",
        }}
      >
        <div role="dialog" aria-modal="true" style={dialogStyle}>
          <div style={headerStyle}>
            <span style={{ fontWeight: 600 }}>{t("relay.localMachine")}</span>
            <button onClick={onClose} style={closeBtnStyle}>×</button>
          </div>

          <div style={{ padding: 16 }}>
            {machinesList.length > 0 ? (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {t("relay.pairedMachines")}（{machinesList.length}）
                </div>
                {machinesList.map((m) => (
                  <div key={m.machineId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                      background: m.online ? "var(--success)" : "#9ca3af",
                      boxShadow: m.online ? "0 0 6px var(--success)" : "none",
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
                      {m.online && m.compatible === false && (
                        <div style={{ fontSize: 11, color: "var(--danger)" }}>
                          客户端版本过低{m.info?.agentVersion ? `（${m.info.agentVersion}）` : ""}，需要 ≥ {m.requiredVersion ?? REQUIRED_CLIENT_VERSION}
                        </div>
                      )}
                    </div>
                    <button
                      disabled={!m.online || busyMachine === m.machineId}
                      onClick={() => { onClose(); setPanel({ machineId: m.machineId }); }}
                      style={{ ...secondaryBtnStyle, opacity: m.online ? 1 : 0.5 }}
                    >
                      {t("relay.panel")}
                    </button>
                    {m.online && m.info && (
                      <WorkspaceRootEditor
                        current={m.info.workspaceRoot}
                        machineId={m.machineId}
                        onSaved={() => refresh()}
                      />
                    )}
                    <button
                      disabled={busyMachine === m.machineId}
                      onClick={() => void renameMachine(m)}
                      style={{ ...closeBtnStyle, fontSize: 13 }}
                      title={t("common.rename")}
                    >
                      ✎
                    </button>
                    <button
                      disabled={busyMachine === m.machineId}
                      onClick={() => void unpairMachine(m)}
                      style={{ ...closeBtnStyle, fontSize: 13, color: "var(--danger)" }}
                      title={t("relay.unbind")}
                    >
                      ⨯
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <p style={{ ...muted, marginTop: 0 }}>
                {t("relay.connectLocalIntro")}
              </p>
            )}

            <div style={{ marginTop: 12, borderTop: machinesList.length > 0 ? "1px solid var(--border)" : "none", paddingTop: 12 }}>
              <button onClick={() => { setPairSectionOpen((v) => !v); setPairing(null); }} style={secondaryBtnStyle}>
                {pairSectionOpen ? t("relay.collapsePairing") : t("relay.pairNewMachine")}
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
                    requiredVersion={requiredVersion}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

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

export function ConnectLocalMachine() {
  const { t } = useI18n();
  const { online, info, requiredVersion } = useRelayAgent();
  const { serverUrl, asset, downloadUrl } = useAgentInstallInfo();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const compat = info ? clientCompatibility(info.agentVersion) : null;

  useEffect(() => {
    if (online) {
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
  }, [online]);

  return (
    <div style={{ padding: 14, height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
      {online && info ? (
        <div style={{ padding: 0 }}>
          <div style={{ color: "var(--success)", fontSize: 13, marginBottom: 12 }}>{t("relay.connected2")}</div>
          <Row label={t("relay.hostname")} value={info.hostname} />
          <Row label={t("relay.os")} value={`${info.os} / ${info.arch}`} />
          <Row label={t("relay.workingDirectory")} value={info.workspaceRoot} />
          <Row
            label={t("relay.agentVersion")}
            value={`${info.agentVersion}${compat?.compatible === false ? ` ⚠ 需要 ≥ ${requiredVersion ?? REQUIRED_CLIENT_VERSION}` : ""}`}
          />
          {compat?.compatible === false && (
            <div className="error-banner" style={{ marginTop: 8 }}>{compat.message}</div>
          )}
        </div>
      ) : (
        <div style={{ padding: 0 }}>
          <p style={{ ...muted, marginTop: 0 }}>
            {t("relay.pairCommandsIntro")}
          </p>
          <PairingSteps
            asset={asset}
            downloadUrl={downloadUrl}
            serverUrl={serverUrl}
            pairing={pairing}
            pairingLoading={pairingLoading}
            label={pairingLabel}
            onLabelChange={setPairingLabel}
            requiredVersion={requiredVersion}
          />
        </div>
      )}
    </div>
  );
}

interface AgentAsset {
  file: string;
  label: string;
  os: "windows" | "darwin" | "linux";
}

/** Shared pairing instructions (label input + code + download/command). */
function PairingSteps({
  asset, downloadUrl, serverUrl, pairing, pairingLoading, label, onLabelChange, requiredVersion,
}: {
  asset: AgentAsset;
  downloadUrl: string;
  serverUrl: string;
  pairing: Pairing | null;
  pairingLoading: boolean;
  label: string;
  onLabelChange: (v: string) => void;
  requiredVersion?: string;
}) {
  const isWindows = asset.os === "windows";
  const exe = isWindows ? ".\\agent-client.exe" : "./agent-client";
  const downloadCommand = isWindows
    ? `Invoke-WebRequest -Uri "${downloadUrl}" -OutFile agent-client.exe`
    : `curl -fsSL -o agent-client "${downloadUrl}" && chmod +x agent-client`;
  const labelArg = label.trim() ? ` --label "${label.trim().replace(/"/g, '\\"')}"` : "";
  const pairCommand = pairing
    ? `${exe} pair --code ${pairing.code} --server ${serverUrl}${labelArg}`
    : "";
  const backgroundCommand = isWindows
    ? `Start-Process -WindowStyle Hidden ${exe} -ArgumentList 'run'`
    : `nohup ./agent-client run > agent-client.log 2>&1 &`;
  const minimumVersion = requiredVersion ?? REQUIRED_CLIENT_VERSION;

  return (
    <>
      <Step n={1} title="下载客户端">
        <CodeBlock code={downloadCommand} />
        <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
          {asset.label} · 需要 ≥ {minimumVersion}
        </div>
      </Step>
      <Step n={2} title="配对">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ ...muted, fontSize: 11, flexShrink: 0 }}>机器名称</span>
          <input
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="可选，如：工位机"
            maxLength={50}
            style={{ flex: 1, padding: "4px 8px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 12 }}
          />
        </div>
        {pairingLoading && <div style={muted}>生成配对码…</div>}
        {!pairingLoading && !pairing && <div style={{ ...muted, color: "var(--danger)" }}>无法生成配对码，请稍后重试。</div>}
        {pairing && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={codeStyle}>{pairing.code}</span>
              <CopyButton text={pairing.code} />
              <span style={{ ...muted, fontSize: 11 }}>5 分钟内有效</span>
            </div>
            <CodeBlock code={pairCommand} />
          </>
        )}
      </Step>
      <Step n={3} title="运行（前台）">
        <CodeBlock code={`${exe} run`} />
        <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
          保持窗口打开；连接成功后会自动继续。
        </div>
      </Step>
      <Step n={4} title="后台运行（可选，专业用户）">
        <CodeBlock code={backgroundCommand} />
        {!isWindows && (
          <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
            systemd：见 agent/contrib/agent-client.service
          </div>
        )}
      </Step>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={spinStyle} />
        <span style={muted}>等待客户端连接…</span>
      </div>
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

/** 更改本机工作区目录：调客户端的 workspace.set-root（校验→持久化到
 *  ~/.agent-client/config.json→热切换并重发 hello）。 */
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
      {msg && <span style={{ fontSize: 11, color: msg === "已更改" ? "var(--success)" : "var(--danger)" }}>{msg}</span>}
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

/** Clipboard write that also works on plain-HTTP LAN origins (where
 *  navigator.clipboard is unavailable and the old silent no-op came from). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function CopyButton({ text, style }: { text: string; style?: React.CSSProperties }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        const copied = await copyText(text);
        setState(copied ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1500);
      }}
      title="复制"
      style={{
        ...closeBtnStyle,
        fontSize: 11,
        padding: "2px 7px",
        border: "1px solid var(--border)",
        borderRadius: 4,
        background: "var(--bg-panel)",
        color: state === "fail" ? "var(--danger)" : state === "ok" ? "var(--success)" : "var(--text-muted)",
        ...style,
      }}
    >
      {state === "ok" ? "已复制" : state === "fail" ? "复制失败" : "复制"}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div style={{ position: "relative" }}>
      <pre style={{
        margin: 0, padding: "8px 46px 8px 10px", background: "var(--bg)",
        border: "1px solid var(--border)", borderRadius: 4, overflow: "auto",
        fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-all",
      }}>
        {code}
      </pre>
      <CopyButton text={code} style={{ position: "absolute", top: 4, right: 4 }} />
    </div>
  );
}

function detectAgentAsset(): AgentAsset {
  if (typeof navigator === "undefined") {
    return { os: "linux", file: clientAssetName("linux", "amd64"), label: "Linux x86_64" };
  }
  const ua = navigator.userAgent.toLowerCase();
  const isArm = /aarch64|arm64|armv8/.test(ua);
  const arch = isArm ? "arm64" : "amd64";
  // Windows on ARM runs the amd64 build under emulation; only that is shipped.
  if (/win/.test(ua)) {
    return { os: "windows", file: clientAssetName("windows", "amd64"), label: "Windows x86_64" };
  }
  if (/mac/.test(ua)) {
    return { os: "darwin", file: clientAssetName("darwin", arch), label: `macOS ${arch}` };
  }
  return { os: "linux", file: clientAssetName("linux", arch), label: `Linux ${arch}` };
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
