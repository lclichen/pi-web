"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Locale } from "@/lib/i18n/types";
import type { SettingsSection } from "@/lib/settings-navigation";

/**
 * WebUI 操作教学（新手向导）。顶栏常驻按钮随时打开；首次访问自动弹出一次
 * （localStorage 记忆，见 AppShell 的挂载逻辑）。
 *
 * 交互：聚光灯（spotlight）导览——步骤可锚定到界面元素（data-guide=…），
 * 遮罩挖出目标区域并跟随其位置（resize/scroll/侧栏动画），说明卡片自动
 * 选择上/下/左/右空间最大的方位；目标不存在或不可见时回落为居中卡片。
 * Esc 关闭，←/→ 翻页。
 *
 * 两条线：
 *   · 基础（basics）：语言 → 界面（会话栏/输入框/文件面板）→ 模型（唯一
 *     必配项）→ 可选配置（子智能体/技能/MCP，只浏览了解）→ 工作区模式
 *     （本地=配对客户端 → 沙盒 → SSH → 快速）→ 第一个会话。
 *   · 进阶（advanced）：开发自定义 Agent——配置包结构、内置 Agent Builder、
 *     迭代方式与交付链路。
 *
 * 与 Lab Training 教学面板无关：那是实验室课程面板（由启动参数
 * PI_WEB_LAB_TRAINING 控制显隐）；本组件是通用产品上手引导。
 */

export interface WebUIGuideProps {
  open: boolean;
  /** skip=true 表示用户主动跳过（记“已完成”）；✕/遮罩只收起并保留进度。 */
  onClose: (options?: { skip?: boolean }) => void;
  /** 深链设置页（models/agents/skills/mcp/bundles…），由 AppShell 的 setSettingsSection 承接。 */
  onOpenSettings: (section: SettingsSection) => void;
  /** 结业动作：直接新建一个快速会话（也可能被用户跳过）。 */
  onStartQuickSession?: () => void;
  /** 「和 Agent 对话」步在没有会话时引导新建项目（打开新建项目向导）。 */
  onNewProject?: () => void;
  /** 按模式打开项目创建向导（沙盒/本地/SSH 直接进入对应配置步）。 */
  onCreateProject?: (method: "sandbox" | "local" | "ssh") => void;
  /** 当前是否已有打开的会话/新会话草稿；false 时第 4 步先引导创建会话。 */
  hasSession?: boolean;
  /** 经配置卡片跳出（向导主动送用户去设置页）——宿主据此显示"继续"胶囊。 */
  onJumpOut?: () => void;
  /** 走完"完成"步正常结束——宿主据此收起胶囊。 */
  onFinished?: () => void;
  /** 管理员才能进 Agents 管理上传配置包；非管理员只给说明。 */
  isAdmin?: boolean;
}

type Track = "basics" | "advanced";

const BASICS_STEPS = [
  "welcome",
  "language",
  "sidebar",
  "chat",
  "files",
  "models",
  "optional",
  "modes",
  "firstSession",
  "done",
] as const;
const ADVANCED_STEPS = ["advIntro", "advBuilder", "advConfig", "advSession", "advDeliver", "advDone"] as const;
type StepId = (typeof BASICS_STEPS)[number] | (typeof ADVANCED_STEPS)[number];

interface AnchorSpec {
  selector: string;
  placement: "top" | "bottom" | "left" | "right";
}

/** 可锚定步骤 → 目标元素。目标不存在/不可见时自动回落居中卡片。 */
const ANCHORS: Partial<Record<StepId, AnchorSpec>> = {
  sidebar: { selector: "#session-sidebar", placement: "right" },
  chat: { selector: '[data-guide="chat"]', placement: "top" },
  files: { selector: '[data-guide="files"]', placement: "top" },
  models: { selector: '[data-guide="models"]', placement: "top" },
  optional: { selector: '[data-guide="settings"]', placement: "top" },
  modes: { selector: '[data-guide="new-project"]', placement: "right" },
  firstSession: { selector: '[data-guide="quick"]', placement: "right" },
  advBuilder: { selector: '[data-guide="settings"]', placement: "top" },
};

const LOCALE_OPTIONS: Array<{ id: Locale; label: string }> = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "en", label: "English" },
];

const CONFIG_LINKS: Array<{ section: SettingsSection; key: string; icon: string }> = [
  { section: "agents", key: "guide.configAgents", icon: "🤖" },
  { section: "skills", key: "guide.configSkills", icon: "📘" },
  { section: "mcp", key: "guide.configMcp", icon: "🔌" },
];

const PROGRESS_KEY = "webui-guide-progress";
const Z = 1500;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Progress {
  track: Track;
  index: number;
}

function readProgress(): Progress | null {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Progress>;
    if (parsed.track !== "basics" && parsed.track !== "advanced") return null;
    if (!Number.isInteger(parsed.index) || (parsed.index as number) < 0) return null;
    return { track: parsed.track, index: parsed.index as number };
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function WebUIGuide({
  open,
  onClose,
  onOpenSettings,
  onStartQuickSession,
  onNewProject,
  onCreateProject,
  hasSession = true,
  onJumpOut,
  onFinished,
  isAdmin = false,
}: WebUIGuideProps) {
  const { t, locale, setLocale } = useI18n();
  const [track, setTrack] = useState<Track>("basics");
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [tipSize, setTipSize] = useState({ w: 460, h: 300 });
  const tipRef = useRef<HTMLDivElement | null>(null);

  const steps = track === "basics" ? BASICS_STEPS : ADVANCED_STEPS;
  const total = steps.length;
  const safeIndex = Math.min(index, total - 1);
  const step = steps[safeIndex] as StepId;
  const isLast = safeIndex === total - 1;
  // 第 4 步「和 Agent 对话」：新用户此时还没有会话，聊天区不存在——改为
  // 引导先新建项目/快速会话，并把聚光灯指向侧栏的「新建项目」。
  const chatNeedsSession = step === "chat" && !hasSession;
  const anchor = useMemo<AnchorSpec | undefined>(
    () => (chatNeedsSession ? { selector: '[data-guide="new-project"]', placement: "right" } : ANCHORS[step]),
    [chatNeedsSession, step],
  );

  // 打开时续到上次进度（"完成"步会清除存储；首次访问无存储 → 第 0 步）。
  useEffect(() => {
    if (!open) return;
    const saved = readProgress();
    if (saved) {
      setTrack(saved.track);
      setIndex(saved.index);
    } else {
      setTrack("basics");
      setIndex(0);
    }
  }, [open]);

  // 步进持久化：任意方式离开（✕/卡片跳出）都保留进度，只有走完/跳过才清除。
  useEffect(() => {
    if (!open || isLast) return;
    try {
      window.localStorage.setItem(PROGRESS_KEY, JSON.stringify({ track, index: safeIndex }));
    } catch {
      /* 忽略 */
    }
  }, [open, track, safeIndex, isLast]);

  const next = useCallback(() => setIndex((i) => Math.min(total - 1, i + 1)), [total]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  const finish = useCallback(() => {
    try {
      window.localStorage.removeItem(PROGRESS_KEY);
      window.localStorage.setItem("webui-guide-done", "1");
    } catch {
      /* 忽略 */
    }
    onFinished?.();
    onClose({ skip: true });
  }, [onClose, onFinished]);

  const skip = useCallback(() => {
    try {
      window.localStorage.removeItem(PROGRESS_KEY);
    } catch {
      /* 忽略 */
    }
    onClose({ skip: true });
  }, [onClose]);

  const jump = useCallback(
    (section: SettingsSection) => {
      onOpenSettings(section);
      onJumpOut?.();
      onClose();
    },
    [onClose, onJumpOut, onOpenSettings],
  );

  const switchTrack = useCallback((nextTrack: Track) => {
    setTrack(nextTrack);
    setIndex(0);
  }, []);

  // 键盘：Esc 关闭，←/→ 翻页。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, next, prev, onClose]);

  // 目标测量：进入步骤、resize、滚动、侧栏动画期间持续跟随。
  // 用 ref 读取"当前步骤的锚点"：步进很快时，旧 effect 里已排队的 interval
  // 回调可能在新 effect 之后落地，闭包里的旧 anchor 会把新 rect 覆写回去
  // （表现为聚光灯停在上一页的目标上）。所有测量统一读 ref 即可避免竞态。
  const anchorRef = useRef<AnchorSpec | undefined>(undefined);
  anchorRef.current = anchor;
  const measureNow = useCallback(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    const current = anchorRef.current;
    if (!current) {
      setRect(null);
      return;
    }
    const el = document.querySelector(current.selector) as HTMLElement | null;
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const visible =
      r.width > 8 &&
      r.height > 8 &&
      r.bottom > 0 &&
      r.top < window.innerHeight &&
      r.right > 0 &&
      r.left < window.innerWidth;
    if (!visible) {
      setRect(null);
      return;
    }
    setRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
  }, []);

  // 步进/轨道变化时立刻测一次（不依赖 interval 的下一次 tick）。
  useEffect(() => {
    if (!open) return;
    measureNow();
    const t1 = window.setTimeout(measureNow, 120);
    const t2 = window.setTimeout(measureNow, 380);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [open, step, track, measureNow]);

  // 常驻跟随：resize / 滚动 / 侧栏开合动画。
  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(measureNow, 250);
    window.addEventListener("resize", measureNow);
    window.addEventListener("scroll", measureNow, true);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", measureNow);
      window.removeEventListener("scroll", measureNow, true);
    };
  }, [open, measureNow]);

  // 目标在视口外时滚进来（侧栏/文件面板的按钮可能被折叠）。
  useEffect(() => {
    if (!open || !anchor) return;
    const el = document.querySelector(anchor.selector) as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [open, anchor, step]);

  // 卡片尺寸测量（内容长短不一，用实测高度决定上下左右哪个方位放得下）。
  useLayoutEffect(() => {
    if (!open) return;
    const el = tipRef.current;
    if (!el) return;
    const measure = () => setTipSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, step, track]);

  const tipWidth = useMemo(() => {
    const available = viewport.w > 0 ? viewport.w - 24 : 560;
    return Math.min(480, Math.max(300, available));
  }, [viewport.w]);

  const tipStyle = useMemo<CSSProperties>(() => {
    const margin = 12;
    if (!rect || !viewport.w) {
      return {
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: Math.min(560, viewport.w > 0 ? viewport.w - 24 : 560),
      };
    }
    const gap = 14;
    const w = tipWidth;
    const h = Math.min(tipSize.h || 300, viewport.h - margin * 2);
    const fits: Record<AnchorSpec["placement"], boolean> = {
      bottom: viewport.h - rect.bottom - gap >= h,
      top: rect.top - gap >= h,
      right: viewport.w - rect.right - gap >= w,
      left: rect.left - gap >= w,
    };
    const order: AnchorSpec["placement"][] = [anchor?.placement ?? "bottom", "bottom", "top", "right", "left"];
    const placement = order.find((p) => fits[p]) ?? "bottom";
    let left: number;
    let top: number;
    if (placement === "top") {
      left = rect.left + rect.width / 2 - w / 2;
      top = rect.top - gap - h;
    } else if (placement === "right") {
      left = rect.right + gap;
      top = rect.top + rect.height / 2 - h / 2;
    } else if (placement === "left") {
      left = rect.left - gap - w;
      top = rect.top + rect.height / 2 - h / 2;
    } else {
      left = rect.left + rect.width / 2 - w / 2;
      top = rect.bottom + gap;
    }
    return {
      left: clamp(left, margin, viewport.w - w - margin),
      top: clamp(top, margin, viewport.h - h - margin),
      width: w,
    };
  }, [rect, viewport, anchor, tipWidth, tipSize.h]);

  if (!open) return null;

  const requiredBadge = (
    <span style={badgeStyle("var(--accent)")}>{t("guide.required")}</span>
  );
  const optionalBadge = <span style={badgeStyle("var(--text-dim)")}>{t("guide.optional")}</span>;

  const stepTitle = (key: string) => (
    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{t(key)}</div>
  );
  const paragraph = (key: string, style?: CSSProperties) => (
    <p style={{ margin: "0 0 10px", ...style }}>{t(key)}</p>
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: Z }}
      role="dialog"
      aria-modal="true"
      aria-label={t("guide.title")}
      onClick={(event) => event.stopPropagation()}
    >
      {/* 聚光灯：挖出目标区域，其余压暗；无目标时整屏压暗。 */}
      {rect ? (
        <div
          style={{
            position: "fixed",
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            borderRadius: 10,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.52)",
            border: "2px solid var(--accent)",
            pointerEvents: "none",
            transition: "left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease",
          }}
        >
          <span
            style={{
              position: "absolute",
              inset: -2,
              borderRadius: 10,
              border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
              pointerEvents: "none",
            }}
          />
        </div>
      ) : (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)" }} />
      )}

      {/* 说明卡片 */}
      <div
        ref={tipRef}
        style={{
          position: "fixed",
          ...tipStyle,
          maxHeight: `calc(100vh - 24px)`,
          overflowY: "auto",
          boxSizing: "border-box",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          color: "var(--text)",
          fontSize: 13,
          lineHeight: 1.75,
          transition: "left 0.2s ease, top 0.2s ease, width 0.2s ease",
        }}
      >
        {/* 头部：标题 + 进度 + 关闭 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 8px" }}>
          <span style={{ fontSize: 17 }}>🎓</span>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            {t("guide.title")}
            <span style={{ fontWeight: 400, color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>
              {track === "basics" ? t("guide.trackBasics") : t("guide.trackAdvanced")} · {safeIndex + 1} / {total}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onClose()}
            aria-label="close"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 16,
              padding: "2px 6px",
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "0 16px 10px" }}>
          {steps.map((key, i) => (
            <div
              key={key}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: i <= safeIndex ? "var(--accent)" : "var(--border)",
                transition: "background 0.15s",
              }}
            />
          ))}
        </div>

        {/* 步骤内容 */}
        <div style={{ padding: "2px 16px 14px" }}>
          {step === "welcome" && (
            <>
              {stepTitle("guide.welcomeTitle")}
              {paragraph("guide.welcomeBody")}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button type="button" onClick={() => switchTrack("basics")} style={trackCardStyle(false)}>
                  <span style={{ fontSize: 18 }}>🧭</span>
                  <span>
                    <div style={{ fontWeight: 700 }}>{t("guide.trackBasics")}</div>
                    <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("guide.trackBasicsDesc")}</div>
                  </span>
                </button>
                <button type="button" onClick={() => switchTrack("advanced")} style={trackCardStyle(true)}>
                  <span style={{ fontSize: 18 }}>🛠️</span>
                  <span>
                    <div style={{ fontWeight: 700 }}>{t("guide.trackAdvanced")}</div>
                    <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("guide.trackAdvancedDesc")}</div>
                  </span>
                </button>
              </div>
            </>
          )}

          {step === "language" && (
            <>
              {stepTitle("guide.languageTitle")}
              {paragraph("guide.languageBody")}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {LOCALE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setLocale(opt.id)}
                    style={{
                      padding: "7px 14px",
                      borderRadius: 7,
                      cursor: "pointer",
                      fontSize: 13,
                      border: `1px solid ${locale === opt.id ? "var(--accent)" : "var(--border)"}`,
                      background: locale === opt.id ? "var(--bg-selected)" : "var(--bg)",
                      color: locale === opt.id ? "var(--accent)" : "var(--text)",
                      fontWeight: locale === opt.id ? 700 : 400,
                    }}
                  >
                    {opt.label}
                    {locale === opt.id ? " ✓" : ""}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === "sidebar" && (
            <>
              {stepTitle("guide.sidebarTitle")}
              {paragraph("guide.sidebarBody")}
              <ul style={listStyle}>
                <li>{t("guide.sidebarBullet1")}</li>
                <li>{t("guide.sidebarBullet2")}</li>
                <li>{t("guide.sidebarBullet3")}</li>
              </ul>
            </>
          )}

          {step === "chat" && (
            <>
              {chatNeedsSession ? (
                <>
                  {stepTitle("guide.chatNoSessionTitle")}
                  {paragraph("guide.chatNoSessionBody")}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {onNewProject && (
                      <button
                        type="button"
                        onClick={() => {
                          onNewProject();
                          onClose();
                        }}
                        style={primaryButtonStyle}
                      >
                        ＋ {t("guide.newProject")}
                      </button>
                    )}
                    {onStartQuickSession && (
                      <button
                        type="button"
                        onClick={() => {
                          onStartQuickSession();
                          onClose();
                        }}
                        style={secondaryButtonStyle}
                      >
                        ⚡ {t("guide.startQuickSession")}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {stepTitle("guide.chatTitle")}
                  {paragraph("guide.chatBody")}
                </>
              )}
            </>
          )}

          {step === "files" && (
            <>
              {stepTitle("guide.filesTitle")}
              {paragraph("guide.filesBody")}
            </>
          )}

          {step === "models" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{t("guide.modelsTitle")}</div>
                {requiredBadge}
              </div>
              {paragraph("guide.modelsBody")}
              <button type="button" onClick={() => jump("models")} style={primaryButtonStyle}>
                🧠 {t("guide.openModels")}
              </button>
            </>
          )}

          {step === "optional" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{t("guide.optionalTitle")}</div>
                {optionalBadge}
              </div>
              {paragraph("guide.optionalBody")}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {CONFIG_LINKS.map(({ section, key: k, icon }) => (
                  <button
                    key={section}
                    type="button"
                    onClick={() => jump(section)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 8,
                      cursor: "pointer",
                      fontSize: 12.5,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text)",
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{icon}</span>
                    <span style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{t(k)}</div>
                      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t(k + "Desc")}</div>
                    </span>
                    <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("guide.optional")}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === "modes" && (
            <>
              {stepTitle("guide.workspaceTitle")}
              {paragraph("guide.workspaceBody")}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(
                  [
                    { id: "local", icon: "💻", name: "guide.modeLocal", desc: "guide.modeLocalDesc", steps: "guide.modeStepsLocal" },
                    { id: "sandbox", icon: "🔧", name: "guide.modeSandbox", desc: "guide.modeSandboxDesc", steps: "guide.modeStepsSandbox" },
                    { id: "ssh", icon: "🔒", name: "guide.modeSsh", desc: "guide.modeSshDesc", steps: "guide.modeStepsSsh" },
                    { id: "quick", icon: "⚡", name: "guide.modeQuick", desc: "guide.modeQuickDesc", steps: "guide.modeStepsQuick" },
                  ] as const
                ).map((mode) => {
                  const available = mode.id === "quick" ? Boolean(onStartQuickSession) : Boolean(onCreateProject);
                  return (
                    <div
                      key={mode.id}
                      style={{
                        padding: "9px 11px",
                        borderRadius: 9,
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>{mode.icon}</span>
                        <b style={{ flex: 1, fontSize: 12.5 }}>{t(mode.name)}</b>
                        <button
                          type="button"
                          disabled={!available}
                          onClick={() => {
                            if (mode.id === "quick") onStartQuickSession?.();
                            else onCreateProject?.(mode.id);
                            onClose();
                          }}
                          style={{
                            ...secondaryButtonStyle,
                            padding: "4px 10px",
                            fontSize: 11.5,
                            opacity: available ? 1 : 0.5,
                            cursor: available ? "pointer" : "not-allowed",
                          }}
                        >
                          {mode.id === "quick" ? `⚡ ${t("guide.startQuickSession")}` : t("guide.modeCreate")}
                        </button>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-dim)" }}>{t(mode.desc)}</div>
                      <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                        → {t(mode.steps)}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{t("guide.modeCreateHint")}</p>
              <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{t("guide.modeHostNote")}</p>
            </>
          )}

          {step === "firstSession" && (
            <>
              {stepTitle("guide.firstSessionTitle")}
              {paragraph("guide.firstSessionBody")}
              {onStartQuickSession && (
                <button
                  type="button"
                  onClick={() => {
                    onStartQuickSession();
                    onClose();
                  }}
                  style={primaryButtonStyle}
                >
                  ⚡ {t("guide.startQuickSession")}
                </button>
              )}
            </>
          )}

          {step === "done" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>✅ {t("guide.doneTitle")}</div>
              {paragraph("guide.doneBody")}
              <button type="button" onClick={() => switchTrack("advanced")} style={secondaryButtonStyle}>
                🛠️ {t("guide.startAdvanced")}
              </button>
            </>
          )}

          {step === "advIntro" && (
            <>
              {stepTitle("guide.advIntroTitle")}
              {paragraph("guide.advIntroBody")}
              <ul style={listStyle}>
                <li>{t("guide.advIntroBullet1")}</li>
                <li>{t("guide.advIntroBullet2")}</li>
                <li>{t("guide.advIntroBullet3")}</li>
              </ul>
            </>
          )}

          {step === "advBuilder" && (
            <>
              {stepTitle("guide.advBuilderTitle")}
              {paragraph("guide.advBuilderBody")}
              {isAdmin ? (
                <button type="button" onClick={() => jump("bundles")} style={primaryButtonStyle}>
                  📦 {t("guide.openBundles")}
                </button>
              ) : (
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-dim)" }}>{t("guide.advBuilderAdminOnly")}</p>
              )}
            </>
          )}

          {step === "advConfig" && (
            <>
              {stepTitle("guide.advConfigTitle")}
              {paragraph("guide.advConfigBody")}
              <ul style={listStyle}>
                <li>{t("guide.advConfigBullet1")}</li>
                <li>{t("guide.advConfigBullet2")}</li>
              </ul>
            </>
          )}

          {step === "advSession" && (
            <>
              {stepTitle("guide.advSessionTitle")}
              {paragraph("guide.advSessionBody")}
            </>
          )}

          {step === "advDeliver" && (
            <>
              {stepTitle("guide.advDeliverTitle")}
              {paragraph("guide.advDeliverBody")}
            </>
          )}

          {step === "advDone" && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>✅ {t("guide.advDoneTitle")}</div>
              {paragraph("guide.advDoneBody")}
              <button type="button" onClick={() => switchTrack("basics")} style={secondaryButtonStyle}>
                🧭 {t("guide.backToBasics")}
              </button>
            </>
          )}
        </div>

        {/* 底部导航 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 16px 12px",
            borderTop: "1px solid var(--border)",
            position: "sticky",
            bottom: 0,
            background: "var(--bg-panel)",
          }}
        >
          <button
            type="button"
            onClick={skip}
            style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }}
          >
            {t("guide.skip")}
          </button>
          {safeIndex > 0 && track === "basics" && (
            <button type="button" onClick={() => switchTrack("advanced")} style={linkButtonStyle}>
              🛠️ {t("guide.trackAdvanced")}
            </button>
          )}
          {safeIndex > 0 && track === "advanced" && (
            <button type="button" onClick={() => switchTrack("basics")} style={linkButtonStyle}>
              🧭 {t("guide.trackBasics")}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {safeIndex > 0 && (
            <button type="button" onClick={prev} style={secondaryButtonStyle}>
              {t("guide.prev")}
            </button>
          )}
          <button type="button" onClick={() => (isLast ? finish() : next())} style={primaryButtonStyle}>
            {isLast ? t("guide.finish") : t("guide.next")}
          </button>
        </div>
      </div>
    </div>
  );
}

function badgeStyle(color: string): CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    padding: "1px 7px",
    borderRadius: 999,
    color,
    border: `1px solid ${color}`,
    letterSpacing: 0.2,
    whiteSpace: "nowrap",
  };
}

const listStyle: CSSProperties = {
  margin: "0 0 8px",
  paddingLeft: 18,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const primaryButtonStyle: CSSProperties = {
  padding: "7px 16px",
  borderRadius: 7,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 600,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "7px 14px",
  borderRadius: 7,
  cursor: "pointer",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
};

const linkButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--accent)",
  fontSize: 11.5,
  fontWeight: 600,
};

function trackCardStyle(advanced: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: 9,
    cursor: "pointer",
    fontSize: 12.5,
    border: `1px solid ${advanced ? "var(--border)" : "var(--accent)"}`,
    background: advanced ? "var(--bg)" : "var(--bg-selected)",
    color: "var(--text)",
  };
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
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "var(--bg-panel)",
        border: "1px solid var(--accent)",
        borderRadius: 999,
        padding: "5px 7px 5px 13px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <button
        type="button"
        onClick={onResume}
        title={t("guide.resumePillTitle")}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--accent)",
          fontSize: 12,
          fontWeight: 600,
          padding: "3px 4px",
        }}
      >
        ▶ {t("guide.resumePill")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="dismiss"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-dim)",
          fontSize: 11,
          padding: "3px 5px",
        }}
      >
        ✕
      </button>
    </div>
  );
}
