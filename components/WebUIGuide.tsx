"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Locale } from "@/lib/i18n/types";
import type { SettingsSection } from "@/lib/settings-navigation";

/**
 * WebUI 操作教学（新手向导）。顶栏常驻按钮随时打开；首次访问自动弹出一次
 * （localStorage 记忆，见 AppShell 的挂载逻辑）。
 *
 * 流程：欢迎 → 语言设置（内嵌即时切换）→ Agent 相关配置（模型/子智能体/
 * 技能/MCP 四个深链按钮）→ 工作区与模式概念 → 开启第一个会话（可直接新建
 * 快速会话）→ 完成。
 *
 * 与 Lab Training 教学面板无关：那是实验室课程面板（由启动参数
 * PI_WEB_LAB_TRAINING 控制显隐）；本组件是通用产品上手引导。
 */

export interface WebUIGuideProps {
  open: boolean;
  onClose: () => void;
  /** 深链设置页（models/agents/skills/mcp…），由 AppShell 的 setSettingsSection 承接。 */
  onOpenSettings: (section: SettingsSection) => void;
  /** 结业动作：直接新建一个快速会话（也可能被用户跳过）。 */
  onStartQuickSession?: () => void;
  /** 经配置卡片跳出（向导主动送用户去设置页）——宿主据此显示"继续"胶囊。 */
  onJumpOut?: () => void;
  /** 走完"完成"步正常结束——宿主据此收起胶囊。 */
  onFinished?: () => void;
}

const STEP_KEYS = ["welcome", "language", "agentConfig", "workspace", "firstSession", "done"] as const;

const LOCALE_OPTIONS: Array<{ id: Locale; label: string }> = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "en", label: "English" },
];

const CONFIG_LINKS: Array<{ section: SettingsSection; key: string; icon: string }> = [
  { section: "models", key: "guide.configModels", icon: "🧠" },
  { section: "agents", key: "guide.configAgents", icon: "🤖" },
  { section: "skills", key: "guide.configSkills", icon: "📘" },
  { section: "mcp", key: "guide.configMcp", icon: "🔌" },
];

const STEP_STORAGE_KEY = "webui-guide-step";

export function WebUIGuide({ open, onClose, onOpenSettings, onStartQuickSession, onJumpOut, onFinished }: WebUIGuideProps) {
  const { t, locale, setLocale } = useI18n();
  const [step, setStep] = useState(0);

  // 打开时续到上次进度（"完成"步会清除存储；首次访问无存储 → 第 0 步）。
  useEffect(() => {
    if (!open) return;
    let next = 0;
    try {
      const saved = Number(window.localStorage.getItem(STEP_STORAGE_KEY));
      if (Number.isInteger(saved) && saved >= 0 && saved < STEP_KEYS.length - 1) next = saved;
    } catch { /* localStorage 不可用则从头开始 */ }
    setStep(next);
  }, [open]);

  // 步进持久化：任意方式离开（✕/跳过/卡片跳出）都保留进度，只有走完
  // "完成"步才清除——重开即续，无需重走。
  useEffect(() => {
    if (!open || step >= STEP_KEYS.length - 1) return;
    try { window.localStorage.setItem(STEP_STORAGE_KEY, String(step)); } catch { /* 忽略 */ }
  }, [open, step]);

  if (!open) return null;
  const key = STEP_KEYS[step];
  const isLast = step === STEP_KEYS.length - 1;
  const finish = () => {
    try {
      window.localStorage.removeItem(STEP_STORAGE_KEY);
      window.localStorage.setItem("webui-guide-done", "1");
    } catch { /* 忽略 */ }
    onFinished?.();
    onClose();
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1180, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)", padding: 16,
      }}
    >
      <div
        style={{
          width: "min(560px, 94vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.35)", overflow: "hidden",
        }}
      >
        {/* 头部：标题 + 进度点 + 关闭 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 10px" }}>
          <span style={{ fontSize: 18 }}>🎓</span>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {t("guide.title")}
            <span style={{ fontWeight: 400, color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>
              {step + 1} / {STEP_KEYS.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16, padding: "2px 6px" }}
          >✕</button>
        </div>
        <div style={{ display: "flex", gap: 5, padding: "0 18px 10px" }}>
          {STEP_KEYS.map((k, i) => (
            <div
              key={k}
              style={{
                flex: 1, height: 3, borderRadius: 2,
                background: i <= step ? "var(--accent)" : "var(--border)",
                transition: "background 0.15s",
              }}
            />
          ))}
        </div>

        {/* 步骤内容 */}
        <div style={{ padding: "4px 18px 14px", overflowY: "auto", color: "var(--text)", fontSize: 13, lineHeight: 1.75 }}>
          {key === "welcome" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{t("guide.welcomeTitle")}</div>
              <p style={{ margin: 0 }}>{t("guide.welcomeBody")}</p>
            </>
          )}

          {key === "language" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{t("guide.languageTitle")}</div>
              <p style={{ margin: "0 0 10px" }}>{t("guide.languageBody")}</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {LOCALE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setLocale(opt.id)}
                    style={{
                      padding: "7px 14px", borderRadius: 7, cursor: "pointer", fontSize: 13,
                      border: `1px solid ${locale === opt.id ? "var(--accent)" : "var(--border)"}`,
                      background: locale === opt.id ? "var(--bg-selected)" : "var(--bg)",
                      color: locale === opt.id ? "var(--accent)" : "var(--text)",
                      fontWeight: locale === opt.id ? 700 : 400,
                    }}
                  >
                    {opt.label}{locale === opt.id ? " ✓" : ""}
                  </button>
                ))}
              </div>
            </>
          )}

          {key === "agentConfig" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{t("guide.agentConfigTitle")}</div>
              <p style={{ margin: "0 0 10px" }}>{t("guide.agentConfigBody")}</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {CONFIG_LINKS.map(({ section, key: k, icon }) => (
                  <button
                    key={section}
                    type="button"
                    onClick={() => { onOpenSettings(section); onJumpOut?.(); onClose(); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                      padding: "9px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12.5,
                      border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{icon}</span>
                    <span>
                      <div style={{ fontWeight: 600 }}>{t(k)}</div>
                      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t(k + "Desc")}</div>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {key === "workspace" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{t("guide.workspaceTitle")}</div>
              <p style={{ margin: "0 0 8px" }}>{t("guide.workspaceBody")}</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li><b>🔧 {t("guide.modeSandbox")}</b> — {t("guide.modeSandboxDesc")}</li>
                <li><b>🔒 {t("guide.modeSsh")}</b> — {t("guide.modeSshDesc")}</li>
                <li><b>💻 {t("guide.modeLocal")}</b> — {t("guide.modeLocalDesc")}</li>
                <li><b>⚡ {t("guide.modeQuick")}</b> — {t("guide.modeQuickDesc")}</li>
              </ul>
            </>
          )}

          {key === "firstSession" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{t("guide.firstSessionTitle")}</div>
              <p style={{ margin: "0 0 10px" }}>{t("guide.firstSessionBody")}</p>
              {onStartQuickSession && (
                <button
                  type="button"
                  onClick={() => { onStartQuickSession(); onClose(); }}
                  style={{
                    padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                    border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff",
                  }}
                >⚡ {t("guide.startQuickSession")}</button>
              )}
            </>
          )}

          {key === "done" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>✅ {t("guide.doneTitle")}</div>
              <p style={{ margin: 0 }}>{t("guide.doneBody")}</p>
            </>
          )}
        </div>

        {/* 底部导航 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px 14px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }}
          >{t("guide.skip")}</button>
          <div style={{ flex: 1 }} />
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              style={{ padding: "7px 14px", borderRadius: 7, cursor: "pointer", fontSize: 12.5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
            >{t("guide.prev")}</button>
          )}
          <button
            type="button"
            onClick={() => (isLast ? finish() : setStep((s) => Math.min(STEP_KEYS.length - 1, s + 1)))}
            style={{
              padding: "7px 16px", borderRadius: 7, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
              border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff",
            }}
          >{isLast ? t("guide.finish") : t("guide.next")}</button>
        </div>
      </div>
    </div>
  );
}


/**
 * "继续操作教学"悬浮胶囊：只在向导经配置卡片把用户送去设置页时出现
 * （教学流自己造成的中断，有义务给回程路）。✕/跳过等主动退出不显示；
 * 手动关闭后本次会话不再出现。由 AppShell 控制可见性。
 */
export function WebUIGuideResumePill({ onResume, onDismiss }: { onResume: () => void; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        position: "fixed", right: 18, bottom: 18, zIndex: 1100,
        display: "flex", alignItems: "center", gap: 4,
        background: "var(--bg-panel)", border: "1px solid var(--accent)", borderRadius: 999,
        padding: "5px 7px 5px 13px", boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
        fontSize: 12, fontWeight: 600,
      }}
    >
      <button
        type="button"
        onClick={onResume}
        title={t("guide.resumePillTitle")}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12, fontWeight: 600, padding: "3px 4px" }}
      >
        ▶ {t("guide.resumePill")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="dismiss"
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11, padding: "3px 5px" }}
      >✕</button>
    </div>
  );
}
