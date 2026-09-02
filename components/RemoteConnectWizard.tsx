"use client";

/**
 * 远程连接向导 — 新建项目的统一入口（沙盒 / 本机 / SSH 预留）。
 *
 * 步骤（左侧竖排 stepper）：① 选择方式 → ② 填写配置 → ③ 连接中 → ④ 选择目录
 *  - 连接沙盒：② 复用 NewProjectDialog 的完整表单（镜像/容器来源/云盘初始化），
 *    ③ 创建并供给容器，④ 展示容器 /workspace 摘要（目录固定，无需选择）。
 *  - 连接本地：② 项目名 + 配对状态说明（agent 按用户配对，多项目共用一条
 *    连接），③ 校验 agent 在线，④ 绑定本机工作目录（保存到项目 workdir）。
 *  - SSH：② 连接配置（主机/端口/用户名/认证方式，可测试连接），③ 自动测试
 *    连接（成功进④，失败给上一步/重试），④ 远程工作目录（完成时创建项目）。
 * 表单控件样式与 NewProjectDialog（沙盒配置页）保持一致：label 字段栈 +
 * 32px 输入框 + 右下角 secondary/primary 按钮。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { NewProjectDialog } from "./NewProjectDialog";
import { ConnectLocalMachine } from "./relay/ConnectLocalMachine";
import { LocalDirectoryPicker } from "./relay/LocalDirectoryPicker";
import { SshDirectoryPicker } from "./relay/SshDirectoryPicker";

type Mode = "sandbox" | "local-machine" | "ssh";
type Step = 1 | 2 | 3 | 4;
type Method = "sandbox" | "local" | "ssh";

interface Props {
  onClose: () => void;
  /** 管理员：① 里追加「打开服务器目录」入口（Host 模式）。 */
  isAdmin?: boolean;
  onOpenServerDirectory?: () => void;
  /** 项目创建成功（沙盒在③完成创建；本地在④完成创建）后回调，参数为项目名。 */
  onCreated: (mode: Mode, name: string) => void;
}

const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: "选择方式" },
  { n: 2, label: "填写配置" },
  { n: 3, label: "连接中" },
  { n: 4, label: "选择目录" },
];

export function RemoteConnectWizard({ onClose, onCreated, isAdmin, onOpenServerDirectory }: Props) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>(1);
  const [method, setMethod] = useState<Method | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 本地模式：② 的项目名 + ④ 的目录
  const [localName, setLocalName] = useState("");
  const [localDir, setLocalDir] = useState("");
  // 沙盒模式：③ 创建出的项目信息
  const [sandboxDone, setSandboxDone] = useState<{ name: string } | null>(null);
  // SSH 模式：② 的连接配置 + 远程工作目录（④）
  const [sshForm, setSshForm] = useState({ host: "", port: "22", username: "root", authType: "password" as "password" | "key", password: "", privateKey: "", passphrase: "" });
  const [sshName, setSshName] = useState("");
  // 本地 agent 配对状态
  const [relayInfo, setRelayInfo] = useState<{ online: boolean; hostname?: string } | null>(null);
  // 本机目录可视化选择器（④ 打开）
  const [localPickerOpen, setLocalPickerOpen] = useState(false);
  // SSH 远程目录可视化选择器（④ 打开；一次性连接，不落盘）
  const [sshPickerOpen, setSshPickerOpen] = useState(false);
  const [sshTesting, setSshTesting] = useState(false);
  const [sshTestMsg, setSshTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // ③ 的自动连接测试：busy 驱动 spinner，retry 计数触发 effect 重跑
  const [sshStep3Busy, setSshStep3Busy] = useState(true);
  const [sshStep3Retry, setSshStep3Retry] = useState(0);
  // 配置模板：平台预置包（可选，创建时初始化 .pi/ 与 labs/）
  const [presets, setPresets] = useState<Array<{ name: string; description: string }>>([]);
  const [presetBundle, setPresetBundle] = useState("");

  const presetRow = (
    <label style={fieldStyle}>
      {t("配置模板（可选）")}
      <select value={presetBundle} onChange={(e) => setPresetBundle(e.target.value)} style={inputStyle}>
        <option value="">{t("不使用模板")}</option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>{p.name}{p.description ? ` — ${p.description}` : ""}</option>
        ))}
      </select>
    </label>
  );

  useEffect(() => {
    void fetch("/api/bundles").then((r) => r.json()).then((d) => {
      setPresets((d.bundles ?? []) as Array<{ name: string; description: string }>);
    }).catch(() => {});
  }, []);

  // ③ 连接中（本地）：轮询 agent 配对状态；未配对时内嵌「连接本地机器」
  // 面板让用户就地完成配对，配对成功自动进入下一步。
  useEffect(() => {
    if (step !== 3 || method !== "local") return;
    let cancelled = false;
    const check = async () => {
      try {
        // /api/agent-relay/status reports `online` (agent WS connected) —
        // there is no separate `paired` state.
        const res = await fetch("/api/agent-relay/status");
        const d = (await res.json()) as { online?: boolean; info?: { hostname?: string } | null };
        if (cancelled) return;
        setRelayInfo({ online: Boolean(d.online), hostname: d.info?.hostname });
        if (d.online) {
          setError(null);
          setStep(4);
        } else {
          setError(t("本机尚未配对：在下方完成配对后将自动继续。"));
        }
      } catch {
        if (!cancelled) setError(t("无法获取本机连接状态"));
      }
    };
    void check();
    const timer = setInterval(check, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [step, method, t]);

  // 沙盒：NewProjectDialog 的 onCreate → 在③执行创建/供给，完成后进④
  const [sandboxInput, setSandboxInput] = useState<{ name: string; imageId?: number; workspaceInit: boolean; existingContainerId?: number } | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);

  const createSandbox = useCallback(async (input: NonNullable<typeof sandboxInput>) => {
    setBusy(true);
    setSandboxBusy(true);
    setError(null);
    try {
      // 工作区初始化：把默认工作区的文件 seed 进新容器的 /workspace。
      let workspaceId: number | undefined;
      if (input.workspaceInit) {
        const res = await fetch("/api/workspaces");
        const d = (await res.json().catch(() => ({}))) as { workspaces?: Array<{ id: number }> };
        workspaceId = d.workspaces?.[0]?.id;
      }
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          mode: "sandbox",
          ...(input.imageId != null ? { imageId: input.imageId } : {}),
          ...(workspaceId != null ? { workspaceId } : {}),
          ...(input.existingContainerId != null ? { containerId: input.existingContainerId } : {}),
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
      setSandboxDone({ name: input.name });
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(2); // 回到配置步并复位对话框按钮
    } finally {
      setBusy(false);
      setSandboxBusy(false);
    }
  }, []);

  // SSH：④ 完成 → 创建项目（写入 ssh.json 凭据）
  const finishSsh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sshName.trim(),
          mode: "ssh",
          workdir: localDir.trim() || undefined,
          presetBundle: presetBundle || undefined,
          ssh: {
            host: sshForm.host.trim(),
            port: Number(sshForm.port) || 22,
            username: sshForm.username.trim(),
            authType: sshForm.authType,
            password: sshForm.authType === "password" ? sshForm.password : undefined,
            privateKey: sshForm.authType === "key" ? sshForm.privateKey : undefined,
            passphrase: sshForm.passphrase || undefined,
          },
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
      onCreated("ssh", sshName.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(2);
    } finally {
      setBusy(false);
    }
  }, [sshName, localDir, sshForm, presetBundle, onCreated, onClose]);
  // 测试 SSH 连接（不落盘；成功返回远端 whoami）。② 的手动按钮与 ③ 的
  // 自动测试共用同一份请求体。
  const sshTestPayload = useCallback(() => ({
    host: sshForm.host.trim(),
    port: Number(sshForm.port) || 22,
    username: sshForm.username.trim(),
    authType: sshForm.authType,
    password: sshForm.password || undefined,
    privateKey: sshForm.privateKey || undefined,
    passphrase: sshForm.passphrase || undefined,
  }), [sshForm]);

  const runSshTest = useCallback(async (): Promise<{ whoami?: string }> => {
    const res = await fetch("/api/host/ssh-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sshTestPayload()),
    });
    const d = (await res.json()) as { ok?: boolean; whoami?: string; error?: string };
    if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
    return { whoami: d.whoami };
  }, [sshTestPayload]);

  const testSsh = async () => {
    setSshTesting(true);
    setSshTestMsg(null);
    try {
      const { whoami } = await runSshTest();
      setSshTestMsg({ ok: true, text: t("连接成功：{user}", { user: whoami ?? "?" }) });
    } catch (e) {
      setSshTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSshTesting(false);
    }
  };
  // SSH：③ 进入即自动测试连接（服务端 readyTimeout 15s）。成功进入④选
  // 目录；失败展示错误并提供「上一步 / 重试」。此前这一步只渲染了 spinner
  // 文案、没有任何逻辑在跑，用户会永远停在「正在创建项目并测试连接…」。
  // 注意必须定义在 runSshTest 之后：deps 数组在渲染期求值，提前引用会踩 TDZ。
  useEffect(() => {
    if (step !== 3 || method !== "ssh") return;
    let cancelled = false;
    setSshStep3Busy(true);
    setError(null);
    void runSshTest()
      .then(() => {
        if (!cancelled) setStep(4);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setSshStep3Busy(false);
      });
    return () => { cancelled = true; };
  }, [step, method, sshStep3Retry, runSshTest]);

  const handleSandboxCreated = useCallback((input: NonNullable<typeof sandboxInput>) => {
    setSandboxInput(input);
    setStep(3);
    void createSandbox(input);
  }, [createSandbox]);

  // 本地：④ 完成 → 创建项目（带 workdir）
  const finishLocal = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: localName.trim(), mode: "local-machine", workdir: localDir.trim() || undefined, presetBundle: presetBundle || undefined }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
      onCreated("local-machine", localName.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [localName, localDir, presetBundle, onCreated, onClose]);

  const methodCards: Array<{ id: string; title: string; sub: string; icon: React.ReactNode; disabled?: boolean; soon?: boolean }> = [
    {
      id: "sandbox", title: t("连接沙盒"), sub: t("平台容器 · 镜像可选"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" />
        </svg>
      ),
    },
    {
      id: "local", title: t("连接本地"), sub: t("你自己的电脑（一个 Agent 连接可跑多个项目）"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
        </svg>
      ),
    },
    {
      id: "server", title: t("打开服务器目录"), sub: t("pi-web 服务器上的目录（Host 模式）"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      ),
    },
    {
      id: "ssh", title: t("SSH 连接"), sub: t("远程主机 · 通过 SSH 执行会话工具"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 17l6-6-6-6M12 19h8" />
        </svg>
      ),
    },
  ];

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1180, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{ display: "flex", width: "min(860px, 94vw)", height: "min(560px, 90vh)", borderRadius: 12, overflow: "hidden", background: "var(--bg-panel)", border: "1px solid var(--border)" }}
      >
        {/* 左侧 stepper */}
        <aside style={{ width: 200, flexShrink: 0, background: "var(--bg)", borderRight: "1px solid var(--border)", padding: "18px 0", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "0 18px 16px", fontWeight: 700, fontSize: 13, color: "var(--text)" }}>{t("远程连接")}</div>
          {STEPS.map((s) => {
            const active = s.n === step;
            const done = s.n < step;
            return (
              <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 18px", color: active ? "var(--accent)" : done ? "var(--text)" : "var(--text-dim)", fontWeight: active ? 600 : 400 }}>
                <span style={{ width: 18, height: 18, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, flexShrink: 0, border: `1px solid ${active ? "var(--accent)" : done ? "var(--success)" : "var(--text-muted)"}`, background: done ? "var(--success)" : "var(--bg)", color: done ? "var(--bg)" : active ? "var(--accent)" : "var(--text-muted)" }}>
                  {s.n}
                </span>
                {t(s.label)}
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ margin: "0 18px", background: "transparent", border: "none", color: "var(--text-dim)", textAlign: "left", padding: "6px 0" }}>
            {t("取消")}
          </button>
        </aside>

        {/* 右侧内容 */}
        <section style={{ flex: 1, display: "flex", flexDirection: "column", padding: "22px 26px", overflow: "auto" }}>
          {step === 1 && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("选择连接方式")}</h2>
              <p style={{ margin: "0 0 18px", fontSize: 12.5, color: "var(--text-dim)" }}>{t("选择进入当前工作区的连接方式，然后继续填写对应的连接配置。")}</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
                {methodCards.filter((c) => (c as { id: string }).id !== "server" || isAdmin).map((c) => (
                  <button
                    key={c.id}
                    disabled={c.disabled}
                    onClick={() => { if (c.id === "server") { onOpenServerDirectory?.(); onClose(); } else { setMethod(c.id as Method); setStep(2); } }}
                    style={{
                      textAlign: "left", padding: "18px 16px", borderRadius: 10,
                      border: `1px solid ${c.disabled ? "var(--border)" : "var(--accent)"}`,
                      background: c.disabled ? "transparent" : "var(--bg)",
                      color: c.disabled ? "var(--text-dim)" : "var(--text)",
                      cursor: c.disabled ? "not-allowed" : "pointer",
                      display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", minHeight: 110,
                      opacity: c.disabled ? 0.65 : 1,
                    }}
                  >
                    <span style={{ color: c.disabled ? "var(--text-dim)" : "var(--accent)" }}>{c.icon}</span>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {c.title}
                      {c.soon && <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 6px", borderRadius: 8, border: "1px solid var(--border)", color: "var(--text-dim)" }}>{t("即将推出")}</span>}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{c.sub}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 2 && method === "sandbox" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("填写连接配置")}</h2>
              <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-dim)" }}>{t("配置沙盒项目的运行环境，创建后项目会话将在容器 /workspace 内执行。")}</p>
              {error && <div className="error-banner">{error}</div>}
              <div style={{ flex: 1, margin: "0 -26px", padding: "0 26px", overflow: "auto" }}>
                <NewProjectDialog mode="sandbox" busy={sandboxBusy} embedded onCancel={() => setStep(1)} onCreate={handleSandboxCreated} />
              </div>
            </>
          )}

          {step === 2 && method === "ssh" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("SSH 连接配置")}</h2>
              <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>{t("会话在 pi-web 服务器上运行，但 bash / 文件读写等工具通过 SSH 在远程主机的工作目录内执行。")}</p>
              {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 460 }}>
                <label style={fieldStyle}>
                  {t("项目名称")}
                  <input value={sshName} onChange={(e) => setSshName(e.target.value)} placeholder="my-ssh-lab" autoFocus style={inputStyle} />
                </label>
                <div style={{ display: "flex", gap: 10 }}>
                  <label style={{ ...fieldStyle, flex: 1 }}>
                    {t("主机地址")}
                    <input value={sshForm.host} onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })} placeholder="192.168.1.100" style={inputStyle} />
                  </label>
                  <label style={{ ...fieldStyle, width: 96 }}>
                    {t("端口")}
                    <input value={sshForm.port} onChange={(e) => setSshForm({ ...sshForm, port: e.target.value.replace(/[^0-9]/g, "") })} placeholder="22" style={inputStyle} />
                  </label>
                </div>
                <label style={fieldStyle}>
                  {t("用户名")}
                  <input value={sshForm.username} onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })} placeholder="root" style={inputStyle} />
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
                  <span>{t("认证方式")}</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="radio" checked={sshForm.authType === "password"} onChange={() => setSshForm({ ...sshForm, authType: "password" })} />
                    {t("密码")}
                  </label>
                  {sshForm.authType === "password" ? (
                    <input type="password" value={sshForm.password} onChange={(e) => setSshForm({ ...sshForm, password: e.target.value })} style={{ ...inputStyle, marginLeft: 22, width: "calc(100% - 22px)" }} />
                  ) : null}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="radio" checked={sshForm.authType === "key"} onChange={() => setSshForm({ ...sshForm, authType: "key" })} />
                    {t("私钥")}
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("（留空使用服务器默认密钥）")}</span>
                  </label>
                  {sshForm.authType === "key" ? (
                    <textarea value={sshForm.privateKey} onChange={(e) => setSshForm({ ...sshForm, privateKey: e.target.value })} rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ ...inputStyle, marginLeft: 22, width: "calc(100% - 22px)", height: "auto", padding: 8, fontFamily: "var(--font-mono)", fontSize: 11, resize: "vertical" }} />
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 30 }}>
                  <button
                    type="button"
                    onClick={() => void testSsh()}
                    disabled={sshTesting || !sshForm.host.trim() || !sshForm.username.trim()}
                    style={{ ...secondaryBtn, opacity: sshTesting || !sshForm.host.trim() || !sshForm.username.trim() ? 0.5 : 1, cursor: sshTesting || !sshForm.host.trim() || !sshForm.username.trim() ? "not-allowed" : "pointer" }}
                  >
                    {sshTesting ? t("测试中…") : t("测试连接")}
                  </button>
                  {sshTestMsg && <span style={{ fontSize: 12, color: sshTestMsg.ok ? "var(--success)" : "#ef4444" }}>{sshTestMsg.text}</span>}
                </div>
                {presetRow}
                <div className="info-banner">{t("SSH 凭据保存在项目配置中（0600 权限），不会随配置包导出。")}</div>
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button onClick={() => setStep(1)} style={secondaryBtn}>{t("上一步")}</button>
                <button className="primary" disabled={!sshForm.host.trim() || !sshForm.username.trim() || !sshName.trim()} onClick={() => setStep(3)} title={!sshName.trim() ? t("请先填写项目名称") : undefined} style={{ ...primaryBtn, opacity: !sshForm.host.trim() || !sshForm.username.trim() || !sshName.trim() ? 0.5 : 1 }}>{t("下一步")}</button>
              </div>
            </>
          )}

          {step === 3 && method === "ssh" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("连接中")}</h2>
              {sshStep3Busy ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-dim)", fontSize: 13 }}>
                  <span className="spinner" /> {t("正在测试 SSH 连接…")}
                </div>
              ) : error ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 460 }}>
                  <div className="error-banner">{error}</div>
                  <div className="info-banner">{t("请返回上一步检查主机地址、端口与认证信息，或重试。")}</div>
                </div>
              ) : null}
              <div style={{ flex: 1 }} />
              {!sshStep3Busy && error && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                  <button onClick={() => { setError(null); setStep(2); }} style={secondaryBtn}>{t("上一步")}</button>
                  <button className="primary" onClick={() => setSshStep3Retry((n) => n + 1)} style={primaryBtn}>{t("重试")}</button>
                </div>
              )}
            </>
          )}

          {step === 3 && method === "sandbox" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("连接中")}</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-dim)", fontSize: 13 }}>
                <span className="spinner" /> {t("正在创建容器并准备项目环境…")}
              </div>
              <div style={{ flex: 1 }} />
            </>
          )}

          {step === 2 && method === "local" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("填写连接配置")}</h2>
              <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>{t("本机模式按用户配对：一个 Agent 连接可以承载多个项目，各项目使用不同的工作目录。")}</p>
              {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 460 }}>
                <label style={fieldStyle}>
                  {t("项目名称")}
                  <input value={localName} onChange={(e) => setLocalName(e.target.value)} placeholder={t("如：my-local-lab")} autoFocus style={inputStyle} />
                </label>
                <div className="info-banner">{t("下一步将在向导内完成本机配对（已配对则直接进入目录选择）。")}</div>
                {presetRow}
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button onClick={() => setStep(1)} style={secondaryBtn}>{t("上一步")}</button>
                <button className="primary" disabled={!localName.trim()} onClick={() => setStep(3)} style={{ ...primaryBtn, opacity: !localName.trim() ? 0.5 : 1 }}>{t("下一步")}</button>
              </div>
            </>
          )}

          {step === 3 && method === "local" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("连接中")}</h2>
              {/* 未配对：提示横幅 + 下方内嵌配对面板；配对成功由轮询自动进入下一步。 */}
              {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
              {relayInfo?.online ? (
                <>
                  <div className="info-banner">{t("本机 Agent 已连接")}{relayInfo.hostname ? `：${relayInfo.hostname}` : ""}</div>
                  <div style={{ flex: 1 }} />
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button onClick={() => setStep(2)}>{t("上一步")}</button>
                    <button className="primary" onClick={() => setStep(4)}>{t("下一步")}</button>
                  </div>
                </>
              ) : (
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", border: "1px solid var(--border)", borderRadius: 10, padding: 6 }}>
                  <ConnectLocalMachine embedded />
                </div>
              )}
            </>
          )}

          {step === 4 && method === "local" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("选择目录")}</h2>
              <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>{t("填写本机上该项目的工作目录（Agent 侧路径，例如 /home/me/projects/demo；留空则使用默认工作区）。")}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 460 }}>
                <label style={fieldStyle}>
                  {t("本机工作目录（可选）")}
                  <div style={{ display: "flex", gap: 8 }}>
                    <input value={localDir} onChange={(e) => setLocalDir(e.target.value)} placeholder="/home/me/projects/demo" style={{ ...inputStyle, flex: 1 }} />
                    <button type="button" onClick={() => setLocalPickerOpen(true)} title={t("打开本机目录浏览器")} style={{ ...secondaryBtn, flexShrink: 0 }}>{t("浏览…")}</button>
                  </div>
                </label>
                {error && <div className="error-banner">{error}</div>}
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button onClick={() => setStep(3)} style={secondaryBtn}>{t("上一步")}</button>
                <button className="primary" disabled={busy || !localName.trim()} onClick={finishLocal} style={{ ...primaryBtn, opacity: busy || !localName.trim() ? 0.5 : 1 }}>
                  {busy ? t("创建中…") : t("完成")}
                </button>
              </div>
            </>
          )}

          {step === 4 && method === "ssh" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("选择目录")}</h2>
              <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)" }}>{t("选择或填写远程主机上该项目的工作目录（例如 /root/projects/demo；留空则使用远程 home）。")}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 460 }}>
                <label style={fieldStyle}>
                  {t("远程工作目录（可选）")}
                  <div style={{ display: "flex", gap: 8 }}>
                    <input value={localDir} onChange={(e) => setLocalDir(e.target.value)} placeholder="/root/projects/demo" style={{ ...inputStyle, flex: 1 }} />
                    <button type="button" onClick={() => setSshPickerOpen(true)} title={t("打开远程目录浏览器")} style={{ ...secondaryBtn, flexShrink: 0 }}>{t("浏览…")}</button>
                  </div>
                </label>
                {error && <div className="error-banner">{error}</div>}
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button onClick={() => setStep(3)} style={secondaryBtn}>{t("上一步")}</button>
                <button className="primary" disabled={busy || !sshName.trim()} onClick={() => void finishSsh()} style={{ ...primaryBtn, opacity: busy || !sshName.trim() ? 0.5 : 1 }}>
                  {busy ? t("创建中…") : t("完成")}
                </button>
              </div>
            </>
          )}

          {step === 4 && method === "sandbox" && (
            <>
              <h2 style={{ margin: "0 0 4px", fontSize: 17, color: "var(--text)" }}>{t("选择目录")}</h2>
              <div className="info-banner">{t("沙盒项目的目录固定为容器 /workspace——项目会话、终端与文件面板都在其中执行。")}</div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="primary" onClick={() => { onCreated("sandbox", sandboxDone?.name ?? ""); onClose(); }}>{t("完成")}</button>
              </div>
            </>
          )}
        </section>
        {localPickerOpen && (
          <div onClick={(e) => { if (e.target === e.currentTarget) setLocalPickerOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)", padding: 20 }}>
            <div style={{ width: "min(560px, 94vw)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{t("浏览本机目录")}</div>
              <LocalDirectoryPicker
                onPick={(abs) => { setLocalDir(abs); setLocalPickerOpen(false); }}
                onClose={() => setLocalPickerOpen(false)}
              />
            </div>
          </div>
        )}
        {sshPickerOpen && (
          <div onClick={(e) => { if (e.target === e.currentTarget) setSshPickerOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 1300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)", padding: 20 }}>
            <div style={{ width: "min(560px, 94vw)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{t("浏览远程目录")}</div>
              <SshDirectoryPicker
                config={sshTestPayload()}
                onPick={(abs) => { setLocalDir(abs); setSshPickerOpen(false); }}
                onClose={() => setSshPickerOpen(false)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 与 NewProjectDialog（沙盒配置页）一致的表单控件样式：label 字段栈、32px
// 输入框、右下角 secondary/primary 按钮。
const fieldStyle = {
  display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)",
} as const;

const inputStyle = {
  height: 32, padding: "0 8px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
} as const;

const secondaryBtn = {
  height: 30, padding: "0 14px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer",
} as const;

const primaryBtn = {
  ...secondaryBtn, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", fontWeight: 600,
} as const;
