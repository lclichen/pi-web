"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_FONT_SIZE_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ProjectTrustStatus, ShellToolSettingsResponse } from "@/lib/api-types";
import { setLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";
import { isThinkingExpandedByDefault, setThinkingExpandedByDefault } from "@/lib/thinking-expansion-preference";
import { ModelsConfig } from "./ModelsConfig";
import { AccountSettings } from "./AccountSettings";
import { ApiKeysConfig } from "./ApiKeysConfig";
import { EmbedConfig } from "./EmbedConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { McpServersConfig } from "./McpServersConfig";
import { QuickTemplatesConfig } from "./QuickTemplatesConfig";
import { PolicyConfig } from "./PolicyConfig";
import { BundlesConfig } from "./BundlesConfig";
import { AdminGlobalConfig } from "./AdminGlobalConfig";
import { SubagentsConfig } from "./SubagentsConfig";
import { ConfigButton, ConfigDetailNavigationContext, ConfigSwitch, type ConfigDetailNavigation } from "./SettingsUi";
import { UpdateCard } from "./UpdateCard";
import { isConfirmDialogOpen, useConfirm } from "./use-confirm";
import { isAnySettingsDirty } from "@/lib/settings-dirty";

interface Props {
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
  /** Admin-only sections (quick-templates) render only for admins. */
  isAdmin?: boolean;
  /** Open the shell's default section when no deep link is present. */
  openAtHome?: boolean;
  /** Current project trust status and the shell's refresh callback. */
  projectTrust?: ProjectTrustStatus | null;
  onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
  onOpenTrustDialog?: () => void;
}

export function SettingsSectionIcon({
  section,
  size = 16,
  strokeWidth = 1.8,
}: {
  section: SettingsSection;
  size?: number;
  strokeWidth?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-section-icon",
  };

  if (section === "general")
    return (
      <svg {...common}>
        <path d="M20 7h-9M14 17H5" />
        <circle cx="7" cy="7" r="3" />
        <circle cx="17" cy="17" r="3" />
      </svg>
    );
  if (section === "models")
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
      </svg>
    );
  if (section === "skills")
    return (
      <svg {...common}>
        <path d="m12 2-10 5 10 5 10-5-10-5Z" />
        <path d="m2 12 10 5 10-5M2 17l10 5 10-5" />
      </svg>
    );
  if (section === "bundles")
    return (
      <svg {...common}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    );
  if (section === "global-config")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.5 4 5.6 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.6-4-9s1.5-6.5 4-9Z" />
      </svg>
    );
  if (section === "quick-templates")
    return (
      <svg {...common}>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    );
  if (section === "mcp")
    return (
      <svg {...common}>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <line x1="17.5" y1="11" x2="17.5" y2="14" />
        <line x1="11" y1="17.5" x2="14" y2="17.5" />
      </svg>
    );
  if (section === "account")
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
      </svg>
    );
  if (section === "policy")
    return (
      <svg {...common}>
        <path d="M12 2 4 5.5v5.3c0 5 3.4 9.6 8 10.7 4.6-1.1 8-5.7 8-10.7V5.5L12 2Z" />
        <path d="m9 12 2 2 4-4.5" />
      </svg>
    );
  if (section === "api-keys")
    return (
      <svg {...common}>
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        <circle cx="8" cy="16" r="0.6" />
        <circle cx="12" cy="16" r="0.6" />
      </svg>
    );
  if (section === "embed")
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M9 9v11" />
        <path d="m14 13 3 2-3 2" />
      </svg>
    );
  if (section === "agents")
    return (
      <svg {...common} className="settings-section-icon is-agent">
        <rect x="5" y="7" width="14" height="11" rx="2" />
        <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" />
    </svg>
  );
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return (
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    );
  }
  if (preference === "dark") {
    return (
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    );
  }
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function GeneralSettings({
  sessionId,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  isAdmin,
}: Pick<Props, "sessionId" | "onSessionReloaded" | "quoteSelectionEnabled" | "onQuoteSelectionChange" | "isAdmin">) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { width: chatContentWidth, setWidth: setChatContentWidth, fontSize, setFontSize } = useChatAppearance();
  const [shellSettings, setShellSettings] = useState<ShellToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // 提问自动继续：按登录用户保存在服务端（/api/user-settings），一个用户
  // 的开关只影响他自己；默认关闭。
  const [askSettings, setAskSettings] = useState<{ askAutoContinue: boolean; askTimeoutMinutes: number } | null>(null);
  const [askSaving, setAskSaving] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const uiHydratingRef = useRef(true);

  useEffect(() => {
    setThinkingExpanded(isThinkingExpandedByDefault());
  }, []);
  const themeOptions: { id: ThemePreference; label: string }[] = [
    { id: "light", label: t("settings.themeLight") },
    { id: "dark", label: t("settings.themeDark") },
    { id: "auto", label: t("settings.themeSystem") },
  ];

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tools/settings")
      .then(async (response) => {
        const data = (await response.json()) as ShellToolSettingsResponse & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setShellSettings(data);
      })
      .catch((cause) => {
        if (!cancelled) setShellError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/user-settings")
      .then(async (response) => {
        const data = (await response.json()) as {
          askAutoContinue?: boolean;
          askTimeoutMinutes?: number;
          ui?: {
            theme?: ThemePreference;
            locale?: string;
            chatWidth?: number;
            chatFontSize?: number;
            thinkingExpanded?: boolean;
            quoteSelection?: boolean;
          };
          error?: string;
        };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) {
          setAskSettings({
            askAutoContinue: Boolean(data.askAutoContinue),
            askTimeoutMinutes: data.askTimeoutMinutes ?? 5,
          });
          const ui = data.ui;
          if (ui) {
            if (ui.theme) setThemePreference(ui.theme);
            if (ui.locale) setLocale(ui.locale as typeof locale);
            if (typeof ui.chatWidth === "number") setChatContentWidth(ui.chatWidth);
            if (typeof ui.chatFontSize === "number") setFontSize(ui.chatFontSize);
            if (typeof ui.thinkingExpanded === "boolean") {
              setThinkingExpandedByDefault(ui.thinkingExpanded);
              setThinkingExpanded(ui.thinkingExpanded);
            }
            if (typeof ui.quoteSelection === "boolean") onQuoteSelectionChange(ui.quoteSelection);
          }
          window.setTimeout(() => {
            uiHydratingRef.current = false;
          }, 300);
        }
      })
      .catch(() => {
        // 用户设置暂不可达（如登录失效）——隐藏该节，不打扰其他设置。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (uiHydratingRef.current) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ui: {
            theme: preference,
            locale,
            chatWidth: chatContentWidth,
            chatFontSize: fontSize,
            thinkingExpanded,
            quoteSelection: quoteSelectionEnabled,
          },
        }),
      }).catch(() => {
        // Best-effort sync; localStorage already has the value.
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [preference, locale, chatContentWidth, fontSize, thinkingExpanded, quoteSelectionEnabled]);

  const toggleAskAutoContinue = async (enabled: boolean) => {
    setAskSaving(true);
    setAskError(null);
    try {
      const response = await fetch("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ askAutoContinue: enabled }),
      });
      const data = (await response.json()) as { askAutoContinue: boolean; askTimeoutMinutes: number; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      // 无需重载会话：服务端在 PUT 后对等待中的提问重新武装/取消倒计时。
      setAskSettings(data);
    } catch (cause) {
      setAskError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAskSaving(false);
    }
  };

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setShellError(null);
    try {
      const response = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = (await response.json()) as ShellToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: "reload" });
        onSessionReloaded();
      }
    } catch (cause) {
      setShellError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.general")}</h2>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.appearance")}</h3>
        <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
          {themeOptions.map((option) => {
            const selected = preference === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setThemePreference(option.id)}
                className="settings-theme-option"
              >
                <ThemeIcon preference={option.id} />
                <span className="settings-theme-option-label">{option.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.chat")}</h3>
        <div className="settings-chat-options">
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.thinkingExpandedDefault")}</span>
            <ConfigSwitch
              checked={thinkingExpanded}
              label={t("settings.thinkingExpandedDefault")}
              onChange={(enabled) => {
                setThinkingExpandedByDefault(enabled);
                setThinkingExpanded(enabled);
              }}
            />
          </div>
          <div className="settings-chat-option settings-chat-range-option">
            <div className="settings-chat-range-header">
              <label htmlFor="settings-chat-content-width">{t("settings.chatContentWidth")}</label>
              <output htmlFor="settings-chat-content-width">{chatContentWidth}px</output>
              <ConfigButton
                variant="ghost"
                size="small"
                className="settings-chat-reset"
                title={t("settings.resetChatContentWidth")}
                aria-label={t("settings.resetChatContentWidth")}
                disabled={chatContentWidth === CHAT_CONTENT_WIDTH_DEFAULT}
                onClick={() => setChatContentWidth(CHAT_CONTENT_WIDTH_DEFAULT)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                </svg>
              </ConfigButton>
            </div>
            <input
              id="settings-chat-content-width"
              type="range"
              min={CHAT_CONTENT_WIDTH_MIN}
              max={CHAT_CONTENT_WIDTH_MAX}
              step={10}
              value={chatContentWidth}
              onChange={(event) => setChatContentWidth(Number(event.target.value))}
            />
          </div>
          <div className="settings-chat-option settings-chat-range-option">
            <div className="settings-chat-range-header">
              <label htmlFor="settings-chat-content-font-size">{t("settings.chatContentFontSize")}</label>
              <output htmlFor="settings-chat-content-font-size">{fontSize}px</output>
              <ConfigButton
                variant="ghost"
                size="small"
                className="settings-chat-reset"
                title={t("settings.resetChatContentFontSize")}
                aria-label={t("settings.resetChatContentFontSize")}
                disabled={fontSize === CHAT_CONTENT_FONT_SIZE_DEFAULT}
                onClick={() => setFontSize(CHAT_CONTENT_FONT_SIZE_DEFAULT)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                </svg>
              </ConfigButton>
            </div>
            <input
              id="settings-chat-content-font-size"
              type="range"
              min={CHAT_CONTENT_FONT_SIZE_MIN}
              max={CHAT_CONTENT_FONT_SIZE_MAX}
              step={1}
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
            />
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.quoteSelection")}</span>
            <ConfigSwitch
              checked={quoteSelectionEnabled}
              label={t("settings.quoteSelection")}
              onChange={onQuoteSelectionChange}
            />
          </div>
        </div>
      </section>

      {shellSettings?.isWindows && (
        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t("settings.shellTool")}</h3>
          <p className="settings-general-description">{t("settings.shellToolDescription")}</p>
          <div className="settings-shell-option">
            <span>{t("settings.usePowerShell")}</span>
            <ConfigSwitch
              checked={shellSettings.powerShellEnabled}
              loading={shellSaving}
              label={t("settings.usePowerShell")}
              onChange={(enabled) => void togglePowerShell(enabled)}
            />
          </div>
          {shellError && (
            <p role="alert" className="settings-general-error">
              {shellError}
            </p>
          )}
        </section>
      )}

      {askSettings && (
        <section className="settings-general-section">
          <h3 className="settings-general-heading">{t("settings.askAutoContinue")}</h3>
          <p className="settings-general-description">
            {t("settings.askAutoContinueDescription", { minutes: askSettings.askTimeoutMinutes })}
          </p>
          {/* 与 Shell 工具开关同款卡片行（420px 封顶）；裸的 switch 行会撑满整列。 */}
          <div className="settings-shell-option">
            <span>{t("settings.askAutoContinue")}</span>
            <ConfigSwitch
              checked={askSettings.askAutoContinue}
              loading={askSaving}
              label={t("settings.askAutoContinue")}
              onChange={(enabled) => void toggleAskAutoContinue(enabled)}
            />
          </div>
          {askError && (
            <p role="alert" className="settings-general-error">
              {askError}
            </p>
          )}
        </section>
      )}

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("common.language")}</h3>
        <div role="radiogroup" aria-label={t("common.language")} className="settings-language-options">
          {supportedLocales.map((plugin) => {
            const selected = locale === plugin.id;
            return (
              <button
                key={plugin.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setLocale(plugin.id as typeof locale)}
                className="settings-language-option"
              >
                <span className="settings-language-radio">
                  {selected && <span className="settings-language-radio-dot" />}
                </span>
                <span className="settings-language-label">{plugin.label}</span>
                <span className="settings-language-code">{plugin.id}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-general-section">
        <UpdateCard isAdmin={isAdmin} />
      </section>
    </div>
  );
}

// A phone shows Settings one level at a time: the sections, a section (its list), a row's detail.
type PhoneLevel = "home" | "section" | "detail";

const PHONE_PARENT_LEVEL: Record<PhoneLevel, PhoneLevel> = { home: "home", section: "home", detail: "section" };
const PHONE_LEVEL_DEPTH: Record<PhoneLevel, number> = { home: 0, section: 1, detail: 2 };
const PHONE_LEVEL_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * A phone's level change slides the new level in: from the right going in,
 * from the left (a shorter way, fading up) going back, as a navigation stack
 * does. The header's Back and title fade in with it. Only the new level moves
 * (the old one is gone at once), so the main area clips it; nothing moves
 * under prefers-reduced-motion.
 */
function animatePhoneLevelChange(main: HTMLElement | null, header: HTMLElement | null, from: PhoneLevel, to: PhoneLevel) {
  if (!main || typeof main.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const forward = PHONE_LEVEL_DEPTH[to] > PHONE_LEVEL_DEPTH[from];
  main.animate(forward
    ? [
      { transform: "translateX(100%)", boxShadow: "-12px 0 24px rgba(0, 0, 0, 0.12)" },
      { transform: "translateX(0)", boxShadow: "-12px 0 24px rgba(0, 0, 0, 0)" },
    ]
    : [{ transform: "translateX(-30%)", opacity: 0.4 }, { transform: "translateX(0)", opacity: 1 }], {
    duration: 280,
    easing: PHONE_LEVEL_EASING,
  });
  header?.querySelectorAll<HTMLElement>(".settings-phone-back, .settings-dialog-title").forEach((element) => {
    element.animate([
      { opacity: 0, transform: `translateX(${forward ? 16 : -16}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: 220, easing: PHONE_LEVEL_EASING });
  });
}

/**
 * The phone's level, with an entry in the browser history for each level
 * entered, so the system Back gesture goes up one level instead of leaving the
 * page. The entry copies the current history state (Next's router reads it)
 * and keeps the URL. Closing Settings drops the entries it added.
 */
function usePhoneSettingsLevel(isPhone: boolean, openAtHome: boolean) {
  const [level, setLevel] = useState<PhoneLevel>(openAtHome ? "home" : "section");
  // A desktop shows a section, so a window narrowed to a phone's width stays
  // on it instead of falling back to the level the panel opened at.
  if (!isPhone && level !== "section") setLevel("section");
  const levelRef = useRef(level);
  levelRef.current = level;
  const pushedRef = useRef(0);

  useEffect(() => {
    if (!isPhone) return;
    const onPopState = () => {
      if (pushedRef.current === 0) return;
      pushedRef.current -= 1;
      setLevel((current) => PHONE_PARENT_LEVEL[current]);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isPhone]);

  const enter = useCallback((next: PhoneLevel) => {
    if (!isPhone) return;
    window.history.pushState(window.history.state, "");
    pushedRef.current += 1;
    setLevel(next);
  }, [isPhone]);

  const goUp = useCallback(() => {
    // An entry this panel added: popstate goes up, as the system Back does.
    if (pushedRef.current > 0) window.history.back();
    else setLevel((current) => PHONE_PARENT_LEVEL[current]);
  }, []);

  const dropHistory = useCallback(() => {
    const pushed = pushedRef.current;
    pushedRef.current = 0;
    if (pushed > 0) window.history.go(-pushed);
  }, []);

  return { level, levelRef, enter, goUp, dropHistory };
}

export function SettingsPanel({
  cwd,
  sessionId,
  initialSection,
  openAtHome = false,
  onClose: closeSettings,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  isAdmin = false,
}: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(() => new Set([section]));
  const tabsScrollboxRef = useRef<HTMLDivElement>(null);
  const isPhone = useIsMobile();
  const phone = usePhoneSettingsLevel(isPhone, openAtHome);
  const { dropHistory, enter: enterPhoneLevel, goUp: goUpPhoneLevel, levelRef: phoneLevelRef } = phone;
  const headerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const shownPhoneLevelRef = useRef(phone.level);
  // Before paint, so the new level never shows in place first.
  useLayoutEffect(() => {
    const from = shownPhoneLevelRef.current;
    shownPhoneLevelRef.current = phone.level;
    if (isPhone && from !== phone.level) animatePhoneLevelChange(mainRef.current, headerRef.current, from, phone.level);
  }, [isPhone, phone.level]);
  const onClose = useCallback(() => {
    dropHistory();
    closeSettings();
  }, [closeSettings, dropHistory]);
  // Named by the detail's active row (ConfigSidebarItem); none until one reports.
  const [detailTitle, setDetailTitle] = useState<string | null>(null);
  const detailNavigation = useMemo<ConfigDetailNavigation>(() => ({
    detailOpen: phone.level === "detail",
    openDetail: () => {
      if (phoneLevelRef.current !== "section") return;
      setDetailTitle(null);
      enterPhoneLevel("detail");
    },
    closeDetail: () => {
      if (phoneLevelRef.current === "detail") goUpPhoneLevel();
    },
    reportDetailTitle: setDetailTitle,
  }), [enterPhoneLevel, goUpPhoneLevel, phone.level, phoneLevelRef]);
  // 分组仅驱动分隔线渲染：个人 | 工作区配置 | 管理员。
  const sections: Array<{
    id: SettingsSection;
    label: string;
    requiresProject: boolean;
    group: "personal" | "workspace" | "admin";
  }> = [
    { id: "general", label: t("settings.general"), requiresProject: false, group: "personal" },
    { id: "account", label: t("settings.account"), requiresProject: false, group: "personal" },
    { id: "api-keys", label: t("settings.apiKeys"), requiresProject: false, group: "personal" },
    { id: "models", label: t("common.models"), requiresProject: false, group: "workspace" },
    { id: "skills", label: t("common.skills"), requiresProject: true, group: "workspace" },
    { id: "agents", label: t("common.agents"), requiresProject: true, group: "workspace" },
    { id: "mcp", label: "MCP", requiresProject: true, group: "workspace" },
    { id: "policy", label: t("settings.policy"), requiresProject: true, group: "workspace" },
    { id: "plugins", label: t("common.plugins"), requiresProject: true, group: "workspace" },
    // Admin-only management sections — their rendering is gated on isAdmin
    // below; they must also appear here or there is no way to navigate to them.
    ...(isAdmin
      ? [
          {
            id: "quick-templates" as const,
            label: t("quickTemplates.quickSessionTemplates"),
            requiresProject: false,
            group: "admin" as const,
          },
          { id: "bundles" as const, label: t("bundles.agentsAdmin"), requiresProject: false, group: "admin" as const },
          {
            id: "global-config" as const,
            label: t("settings.globalConfig"),
            requiresProject: false,
            group: "admin" as const,
          },
          {
            id: "embed" as const,
            label: t("embed.settingsTitle"),
            requiresProject: false,
            group: "admin" as const,
          },
        ]
      : []),
  ];

  useEffect(() => setLastSettingsSection(initialSection), [initialSection]);

  // 有未保存草稿（设置分区经 lib/settings-dirty 注册）时，关闭需二次确认。
  const requestClose = useCallback(() => {
    if (isAnySettingsDirty()) {
      void confirm({
        title: t("settings.dirtyTitle"),
        message: t("settings.dirtyCloseMessage"),
        confirmLabel: t("common.discardChanges"),
        abortLabel: t("common.cancel"),
        danger: true,
      }).then((ok) => {
        if (ok) onClose();
      });
      return;
    }
    onClose();
  }, [confirm, onClose, t]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isConfirmDialogOpen()) return; // 确认对话框自行处理 Escape
      event.preventDefault();
      requestClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  useEffect(() => {
    if (cwd || (section !== "skills" && section !== "agents" && section !== "plugins" && section !== "policy")) return;
    setSection("general");
    setMountedSections((current) => new Set(current).add("general"));
    setLastSettingsSection("general");
  }, [cwd, section]);

  // 恢复的上次分区是管理员专属而当前用户不是管理员（同源 localStorage 在
  // 多用户间共享）→ 面板会渲染成空白，重置到通用分区。
  useEffect(() => {
    if (
      isAdmin ||
      (section !== "quick-templates" && section !== "bundles" && section !== "global-config" && section !== "embed")
    )
      return;
    setSection("general");
    setMountedSections((current) => new Set(current).add("general"));
    setLastSettingsSection("general");
  }, [section, isAdmin]);

  const activateSection = (nextSection: SettingsSection) => {
    setMountedSections((current) => new Set(current).add(nextSection));
    setSection(nextSection);
    setLastSettingsSection(nextSection);
    if (isPhone && phoneLevelRef.current === "home") enterPhoneLevel("section");
    // 深链/恢复进入分区时，把激活 tab 滚进可视区（tab 条可横向滚动）。
    requestAnimationFrame(() => {
      tabsScrollboxRef.current
        ?.querySelector('.settings-section-tab[aria-current="page"]')
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  };

  // tab 条可滚动时在两侧显示渐隐提示（can-scroll-left/right 类）；严重溢出
  // 时收起文字仅留图标（is-compact），避免末尾分区被静默裁掉。轻微溢出
  // （例如英文长标签）保留文字 + 横向滚动：一开面板就全变图标反而更难认。
  // 紧凑判定按"带文字的自然宽度"测量：临时摘类→量→再决定，同帧完成
  // 不会产生可见抖动。
  useEffect(() => {
    const wrapper = tabsScrollboxRef.current;
    const scroller = wrapper?.querySelector<HTMLElement>(".settings-section-tabs");
    if (!wrapper || !scroller) return;
    // 标签条自然宽度超出可视宽 160px 以内：保留文字，允许横向滚动。
    const COMPACT_OVERFLOW_PX = 160;
    const update = () => {
      if (scroller.classList.contains("is-compact")) scroller.classList.remove("is-compact");
      const overflow = scroller.scrollWidth - scroller.clientWidth;
      scroller.classList.toggle("is-compact", overflow > COMPACT_OVERFLOW_PX);
      wrapper.classList.toggle("can-scroll-left", scroller.scrollLeft > 4);
      wrapper.classList.toggle(
        "can-scroll-right",
        scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4,
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [cwd, isAdmin, section, t]);

  const sectionHost = (id: SettingsSection, content: ReactNode) =>
    mountedSections.has(id) ? (
      <div key={id} hidden={section !== id} className="settings-section-host">
        {content}
      </div>
    ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
      className="settings-dialog-backdrop"
    >
      <div className="settings-dialog-surface">
        <div className="settings-dialog-header" ref={headerRef}>
          {isPhone && phone.level !== "home" && (
            <button
              type="button"
              className="settings-phone-back"
              onClick={goUpPhoneLevel}
              title={t("skills.documentBack")}
              aria-label={t("skills.documentBack")}
            >
              ‹
            </button>
          )}
          <strong className="settings-dialog-title">
            {isPhone && phone.level !== "home"
              ? phone.level === "detail"
                ? detailTitle ?? sections.find((item) => item.id === section)?.label ?? t("settings.title")
                : sections.find((item) => item.id === section)?.label ?? t("settings.title")
              : t("settings.title")}
          </strong>
          <select
            aria-label={t("settings.sectionPicker")}
            value={section}
            onChange={(event) => activateSection(event.target.value as SettingsSection)}
            className="settings-mobile-section-picker"
          >
            {sections.map((item) => (
              <option key={item.id} value={item.id} disabled={item.requiresProject && !cwd}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="settings-tabs-scrollbox" ref={tabsScrollboxRef}>
            <nav aria-label={t("settings.title")} className="settings-section-tabs">
              {sections.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 && sections[index - 1].group !== item.group && (
                    <span aria-hidden="true" className="settings-section-divider" />
                  )}
                  <button
                    type="button"
                    className="settings-section-tab"
                    disabled={item.requiresProject && !cwd}
                    title={item.requiresProject && !cwd ? t("settings.projectRequired") : item.label}
                    aria-label={item.label}
                    aria-current={section === item.id ? "page" : undefined}
                    onClick={() => activateSection(item.id)}
                  >
                    <SettingsSectionIcon section={item.id} />
                    <span>{item.label}</span>
                  </button>
                </Fragment>
              ))}
            </nav>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            className="config-close-button settings-dialog-close"
          >
            ×
          </button>
        </div>

        <main className="settings-dialog-main" ref={mainRef}>
          {isPhone && phone.level === "home" ? (
            <nav className="settings-phone-section-list" aria-label={t("settings.title")}>
              {sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="settings-phone-section"
                  disabled={item.requiresProject && !cwd}
                  onClick={() => activateSection(item.id)}
                >
                  <SettingsSectionIcon section={item.id} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          ) : (
          <ConfigDetailNavigationContext.Provider value={detailNavigation}>
          {sectionHost(
            "general",
            <GeneralSettings
              sessionId={sessionId}
              onSessionReloaded={onSessionReloaded}
              quoteSelectionEnabled={quoteSelectionEnabled}
              onQuoteSelectionChange={onQuoteSelectionChange}
              isAdmin={isAdmin}
            />,
          )}
          {sectionHost("account", <AccountSettings />)}
          {sectionHost("api-keys", <ApiKeysConfig />)}
          {sectionHost("models", <ModelsConfig embedded onClose={onClose} />)}
          {cwd && sectionHost("skills", <SkillsConfig embedded key={cwd} cwd={cwd} onClose={onClose} isAdmin={isAdmin} />)}
          {cwd && sectionHost("agents", <SubagentsConfig embedded key={cwd} cwd={cwd} onClose={onClose} isAdmin={isAdmin} />)}
          {cwd &&
            sectionHost("mcp", <McpServersConfig embedded key={cwd} cwd={cwd} onClose={onClose} isAdmin={isAdmin} />)}
          {cwd && sectionHost("policy", <PolicyConfig embedded key={cwd} cwd={cwd} />)}
          {isAdmin && sectionHost("quick-templates", <QuickTemplatesConfig embedded />)}
          {isAdmin && sectionHost("bundles", <BundlesConfig embedded />)}
          {isAdmin && sectionHost("global-config", <AdminGlobalConfig />)}
          {isAdmin && sectionHost("embed", <EmbedConfig isAdmin={isAdmin} />)}
          {cwd &&
            sectionHost(
              "plugins",
              <PluginsConfig
                embedded
                isAdmin={isAdmin}
                key={cwd}
                cwd={cwd}
                sessionId={sessionId}
                onClose={onClose}
                onReloaded={onSessionReloaded}
              />,
            )}
          </ConfigDetailNavigationContext.Provider>
          )}
        </main>
      </div>
      {confirmDialog}
    </div>
  );
}
