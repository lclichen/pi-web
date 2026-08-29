"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { GitPanel } from "./GitPanel";
import { LabTrainingSidePanel, type WidgetState as LabWidgetState } from "./LabTrainingSidePanel";
import { TabBar, type Tab } from "./TabBar";
import { SubagentsConfig } from "./SubagentsConfig";
import { McpServersConfig } from "./McpServersConfig";
import { ConnectLocalMachine } from "./relay/ConnectLocalMachine";
import { SandboxManagerDialog } from "./SandboxManagerDialog";
import { MyWorkspaceDialog } from "./MyWorkspaceDialog";
import { WorkspaceTerminal } from "./WorkspaceTerminal";
import { SubagentDirectoryPanel } from "./SubagentDirectoryPanel";
import { PlanPanel } from "./PlanPanel";
import type { SubagentCall } from "@/hooks/useAgentSession";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile, useIsNarrowMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";
import { getInitialNavigation } from "@/lib/initial-navigation";
import {
  clearLastOpen,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { ToolEntry } from "@/lib/tool-presets";
import { getSessionFamily } from "@/lib/session-family";
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;
const AGENT_PANEL_WIDTH = 420;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { preference, toggleTheme } = useTheme();
  const themeLabelKey =
    preference === "light" ? "theme.light" : preference === "dark" ? "theme.dark" : "theme.auto";
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  const isNarrowMobile = useIsNarrowMobile();
  useViewportHeight();

  // Once the user has granted notification permission, register a Web Push
  // subscription so the server can notify backgrounded PWAs (notably iOS,
  // which suspends page JS and never receives the SSE completion event).
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    void setupPushSubscription(locale);
  }, [locale]);
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
  }, []);
  const sessionsWithSelection = useMemo(() => {
    if (!selectedSession) return sessionCatalog;
    return [
      ...sessionCatalog.filter((session) => session.id !== selectedSession.id),
      selectedSession,
    ];
  }, [selectedSession, sessionCatalog]);
  const activeSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, selectedSession?.id),
    [selectedSession?.id, sessionsWithSelection],
  );
  const hasSubagentSessions = Boolean(activeSessionFamily?.subagents.length);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionMode, setNewSessionMode] = useState<"host" | "sandbox" | "local-machine">("host");
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null);
  // Display name of the pending remote session's project (header badge).
  const [newSessionProjectLabel, setNewSessionProjectLabel] = useState<string | null>(null);
  const [sessionSpace, setSessionSpace] = useState<"mine" | "host">("mine");
  // Web identity (PI_WEB_AUTH): null while loading, {user} when logged in.
  const [webUser, setWebUser] = useState<{ id: number; username: string; role: "admin" | "user" } | null | "loading">("loading");
  // Deployment-wide Lab Training toggle (PI_WEB_LAB_TRAINING seeds the
  // default; admins can flip it at runtime via /api/server-settings).
  const [labTrainingEnabled, setLabTrainingEnabled] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(true);
  // Admin-only link to the sandbox platform ops console (from /api/webauth/me).
  const [platformConsoleUrl, setPlatformConsoleUrl] = useState<string | null>(null);
  // Sandbox manager dialog: null = closed; bind = project context (optional).
  const [myWorkspaceOpen, setMyWorkspaceOpen] = useState(false);
  const [sandboxManager, setSandboxManager] = useState<
    { projectId?: string; projectName?: string; containerId?: number } | null
  >(null);
  const [projectsRefreshKey, setProjectsRefreshKey] = useState(0);
  useEffect(() => {
    fetch("/api/webauth/me")
      .then(async (r) => {
        // 401 也读 body：authEnabled 标识单用户模式，必须与"会话失效"区分。
        const d = (await r.json().catch(() => ({}))) as {
          authEnabled?: boolean;
          user?: { id: number; username: string; role: "admin" | "user" } | null;
          labTraining?: boolean;
        };
        setLabTrainingEnabled(d?.labTraining !== false);
        if (d?.authEnabled === false) {
          setAuthEnabled(false);
          setWebUser(null);
          return;
        }
        setAuthEnabled(true);
        setWebUser(d?.user ? { id: d.user.id, username: d.user.username, role: d.user.role } : null);
      })
      .catch(() => setWebUser(null));
  }, []);
  // 登录态失效（session 过期、pi-web 重启后内存 session 丢失但浏览器 cookie
  // 仍在 → proxy 放行、API 层 401）时回登录页，而不是停在主界面。
  useEffect(() => {
    if (authEnabled && webUser !== "loading" && webUser === null) {
      router.replace("/login");
    }
  }, [authEnabled, webUser, router]);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [agentsConfigOpen, setAgentsConfigOpen] = useState(false);
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoadIdRef.current += 1;
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "system" | "tools" | "session" | "language" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!sessionHasBranches) {
      setActiveTopPanel((panel) => panel === "branches" ? null : panel);
    }
  }, [sessionHasBranches]);

  useEffect(() => {
    if (!hasSubagentSessions) {
      setActiveTopPanel((panel) => panel === "agents" ? null : panel);
    }
  }, [hasSubagentSessions]);

  const toggleTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session" | "language",
    keepMobileToolbarOpen = false,
  ) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile]);

  const handleSystemInfoToggle = useCallback((
    panel: "system" | "tools",
    keepMobileToolbarOpen = false,
  ) => {
    const opening = activeTopPanel !== panel;
    toggleTopPanel(panel, keepMobileToolbarOpen);
    if (!opening || systemInfoLoading) return;

    const load = systemInfoLoaderRef.current;
    if (!load) return;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoadIdRef.current === loadId) {
        setSystemInfoLoading(false);
      }
    });
  }, [activeTopPanel, systemInfoLoading, toggleTopPanel]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setMobileToolbarMoreOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, []);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile]);

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [isMobile, isNarrowMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "language" && !isMobile && languageBtnRef.current) {
        const buttonRect = languageBtnRef.current.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(
          buttonRect.left - 1,
          Math.max(topBarRect.left, topBarRect.right - width),
        );
        setTopPanelPos({ top: topBarRect.bottom, left, width });
        return;
      }
      if (activeTopPanel === "agents") {
        setTopPanelPos({
          top: topBarRect.bottom,
          left: topBarRect.left,
          width: Math.min(AGENT_PANEL_WIDTH, topBarRect.width),
        });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    if (languageBtnRef.current) ro.observe(languageBtnRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelMode, setRightPanelMode] = useState<"files" | "git" | "agents" | "plan">("files");
  // Terminal bottom drawer: mounts on first open per terminal key (session /
  // cwd), then toggles via height so the PTY survives collapse. Resizable by
  // dragging the handle above it.
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);
  const [terminalDrawerMounted, setTerminalDrawerMounted] = useState(false);
  const [terminalDrawerHeight, setTerminalDrawerHeight] = useState(280);
  // 活动会话的执行模式：选中会话带 mode；新建会话用 newSessionMode。
  const activeSessionMode = selectedSession?.mode ?? (selectedSession === null && newSessionCwd !== null ? newSessionMode : undefined);
  // Memoized identity: consumers (WorkspaceTerminal effect deps, FileExplorer)
  // treat this object as "the remote context" — a fresh object per render would
  // tear down and recreate the container PTY on every stats update.
  const remoteSessionCtx = useMemo(
    () => (activeSessionMode && activeSessionMode !== "host" && selectedSession
      ? { sessionId: selectedSession.id, label: activeSessionMode === "sandbox" ? translate("沙箱容器") : translate("本机") }
      : null),
    [activeSessionMode, selectedSession],
  );
  // A remote-mode session that has not materialized yet (no first message):
  // file/terminal panels must wait instead of hitting the local APIs. Binds to
  // the explicit new-session intent (mode + projectId), never to a cwd value —
  // a remote session's "/" cwd must never fall through to host behavior.
  const pendingRemoteSession = selectedSession === null
    && newSessionCwd !== null
    && newSessionMode !== "host"
    ? newSessionMode
    : null;

  // Live subagent calls lifted from the active ChatWindow (useAgentSession).
  const [subagentCalls, setSubagentCalls] = useState<SubagentCall[]>([]);

  // Lab Training panel — merged into the left sidebar (section node passed down)
  const [labWidget, setLabWidget] = useState<{ metadata?: unknown } | null>(null);
  const [hasLabTraining, setHasLabTraining] = useState(false);
  const sendCommandRef = useRef<((cmd: string) => void) | null>(null);

  const handleSendCommand = useCallback((cmd: string) => {
    sendCommandRef.current?.(cmd);
  }, []);

  const handleStartLabTraining = useCallback(() => {
    const cwd = selectedSession?.cwd ?? newSessionCwd;
    if (!cwd) return;
    // Navigate to new session view, then send /lab on next tick.
    // This ensures the training starts in a fresh, isolated session
    // with its own extension state (step position, QA mode, etc).
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    router.replace("/", { scroll: false });
    // Wait for the next render cycle before sending the command
    setTimeout(() => {
      sendCommandRef.current?.("/lab");
    }, 100);
  }, [selectedSession?.cwd, newSessionCwd, router]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // Terminal bottom drawer — keys to the session/cwd exactly like the old
  // right-panel terminal did: switching key unmounts (and closes) the drawer.
  const terminalDrawerKey = remoteSessionCtx
    ? remoteSessionCtx.sessionId
    : (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) ?? null;
  useEffect(() => {
    setTerminalDrawerMounted(false);
    setTerminalDrawerOpen(false);
  }, [terminalDrawerKey]);
  const openTerminalDrawer = useCallback(() => {
    setTerminalDrawerMounted(true);
    setTerminalDrawerOpen(true);
  }, []);
  // Drag the top edge to resize the drawer (min 140px, max 75% of the chat column).
  const terminalDrawerRef = useRef<HTMLDivElement | null>(null);
  const startTerminalDrawerResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = terminalDrawerHeight;
    const maxHeight = Math.max(200, (terminalDrawerRef.current?.parentElement?.clientHeight ?? 600) * 0.75);
    const onMove = (ev: MouseEvent) => {
      const next = startHeight + (startY - ev.clientY);
      setTerminalDrawerHeight(Math.min(maxHeight, Math.max(140, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [terminalDrawerHeight]);

  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectKey
      ?? activeProjectKeyRef.current
      ?? workspaceKeyOf(selectedSession);
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        const draftId = `initial:${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  // Unidirectional host-directory switch: the sidebar calls this ONLY at its
  // genuine switch sites (dropdown / custom path / default cwd / worktree
  // create/remove/switch). Session selection and new-session flows never come
  // through here, so no echo guards are needed anymore.
  //
  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if (workspaceKeyOf(s) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    invalidateWorkspaceRestore();
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = `new:${draftId}:${cwd}`;
    setSelectedSession(null);
    // Switching project directories (e.g. the admin directory picker) starts
    // a HOST session in the new folder: stale newSessionMode/newSessionProjectId
    // from a previously open project would silently route the new session back
    // into that project (server-side projectId branch wins over cwd).
    setNewSessionMode("host");
    setNewSessionProjectId(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (currentProject !== newProject) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);
      setActiveFileTabId(null);
      setRightPanelOpen(false);
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      restoreWorkspaceContext(newProject);
    }
    router.replace("/", { scroll: false });
  }, [activeCwd, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [invalidateWorkspaceRestore, router, isMobile, selectedSession]);

  const handleNewSession = useCallback((sessionId: string, cwd: string, mode?: "host" | "sandbox" | "local-machine", projectId?: string, projectLabel?: string) => {
    invalidateWorkspaceRestore();
    const draftKey = `new:${sessionId}:${cwd}`;
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    if (mode) setNewSessionMode(mode);
    setNewSessionProjectId(projectId ?? null);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [invalidateWorkspaceRestore, router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  const handleOpenSession = useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !data.info) throw new Error(data.error ?? `HTTP ${response.status}`);
      handleSelectSession(data.info);
    } catch (error) {
      console.error("[pi-web] failed to open session:", error instanceof Error ? error.message : error);
    }
  }, [handleSelectSession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
      void setupPushSubscription(locale);
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") {
          fire();
          void setupPushSubscription(locale);
        }
      });
    }
  }, [handleSelectSession, locale]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);

    if (selectedSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    const targetSession = selectedSession;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });
  }, [deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (selectedSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      const draftId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [invalidateWorkspaceRestore, selectedSession, router]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint,
      sourceSessionId,
      tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  // Dirty flag of the active file tab (only the active tab can be dirty —
  // switching tabs hard-resets edit state in FileViewer). Closing the active
  // dirty tab confirms before discarding.
  const [activeFileDirty, setActiveFileDirty] = useState(false);

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (tabId === activeFileTabId && activeFileDirty) {
      const discard = window.confirm(translate("此文件有未保存的修改，关闭将丢弃。确定关闭吗？"));
      if (!discard) return;
      setActiveFileDirty(false);
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs, activeFileTabId, activeFileDirty]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    // Trust is a host-space concept (server directories opened via the CLI /
    // directory picker). Sandbox/local project homes are pi-web-managed and
    // outside the file-access roots — querying them would 403 noisily.
    if (!projectTrustCwd || (activeSessionMode && activeSessionMode !== "host")) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd, activeSessionMode]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - amedac.ai` : "amedac.ai";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        authInfo={webUser === "loading" ? { enabled: false, user: null } : (webUser ? { enabled: true, user: webUser } : { enabled: true, user: null })}
        sessionSpace={sessionSpace}
        onSessionSpaceChange={setSessionSpace}
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        onFileDeleted={(filePath) => {
          const tabId = `file:${filePath}`;
          if (fileTabs.some((t) => t.id === tabId)) handleCloseFileTab(tabId);
          setExplorerRefreshKey((k) => k + 1);
        }}
        onFileRenamed={(oldPath, newPath) => {
          const oldTabId = `file:${oldPath}`;
          setFileTabs((prev) => prev.map((t) =>
            t.id === oldTabId
              ? { ...t, id: `file:${newPath}`, filePath: newPath, label: getFileName(newPath) }
              : t,
          ));
          if (activeFileTabId === oldTabId) {
            setActiveFileTabId(`file:${newPath}`);
          }
          setExplorerRefreshKey((k) => k + 1);
        }}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onManageSandbox={(project) =>
          setSandboxManager({ projectId: project.id, projectName: project.name, containerId: project.containerId })
        }
        projectsRefreshKey={projectsRefreshKey}
              onProjectsChanged={() => setProjectsRefreshKey((k) => k + 1)}
        pendingRemoteMode={pendingRemoteSession}
        remoteSessionProp={remoteSessionCtx}
        pendingProjectLabel={
          pendingRemoteSession
            ? newSessionProjectLabel ?? translate("新会话")
            : (selectedSession?.mode && selectedSession.mode !== "host" ? (selectedSession.name ? translate("会话：{name}", { name: selectedSession.name }) : translate("远程会话")) : null)
        }
        labPanelNode={labTrainingEnabled ? (
          <LabTrainingSidePanel
            hideHeader
            widgetState={(labWidget?.metadata as LabWidgetState | undefined) ?? null}
            hasLabTraining={hasLabTraining}
            onSendCommand={handleSendCommand}
            onStartLabTraining={handleStartLabTraining}
          />
        ) : undefined}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionsChange={handleSessionsChange}
      />
      <div style={{ padding: "6px 8px", flexShrink: 0, display: "flex", flexWrap: "wrap", gap: 3 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = section !== "models" && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate("settings.projectRequired") : label}
              aria-label={label}
              style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 32, padding: 0, background: "none", border: "none",
                borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
                fontSize: 12, opacity: disabled ? 0.35 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
            fontSize: 12, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate("common.settings")}</span>
        </button>
        {/* Platform extras: tintinweb subagents + MCP servers are dev-side
            features not covered by the upstream settings sections. */}
        <button
          type="button"
          onClick={() => setAgentsConfigOpen(true)}
          disabled={!activeCwd && !selectedSession?.cwd && !newSessionCwd}
          title="Agents"
          aria-label="Agents"
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)",
            cursor: (!activeCwd && !selectedSession?.cwd && !newSessionCwd) ? "default" : "pointer",
            fontSize: 12, opacity: (!activeCwd && !selectedSession?.cwd && !newSessionCwd) ? 0.35 : 1,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
          </svg>
          <span>Agents</span>
        </button>
        <button
          type="button"
          onClick={() => setMcpConfigOpen(true)}
          disabled={!activeCwd && !selectedSession?.cwd && !newSessionCwd}
          title="MCP"
          aria-label="MCP"
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)",
            cursor: (!activeCwd && !selectedSession?.cwd && !newSessionCwd) ? "default" : "pointer",
            fontSize: 12, opacity: (!activeCwd && !selectedSession?.cwd && !newSessionCwd) ? 0.35 : 1,
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <line x1="17.5" y1="11" x2="17.5" y2="14" />
            <line x1="11" y1="17.5" x2="14" y2="17.5" />
          </svg>
          <span>MCP</span>
        </button>
      </div>
    </>
  );

  const renderThemeButton = (mobile: boolean) => (
    <button
      type="button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
      }}
      title={translate(themeLabelKey)}
      aria-label={translate(themeLabelKey)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      data-mobile-toolbar-action={mobile ? "theme" : undefined}
    >
      {preference === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : preference === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )}
    </button>
  );

  const renderLanguageButton = (mobile: boolean) => (
    <button
      ref={languageBtnRef}
      type="button"
      onClick={() => toggleTopPanel("language", mobile)}
      title={translate("common.language")}
      aria-label={translate("common.language")}
      aria-haspopup="menu"
      aria-expanded={activeTopPanel === "language"}
      aria-pressed={activeTopPanel === "language"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
        border: "none", borderRight: "1px solid var(--border)",
        color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
      }}
      data-mobile-toolbar-action={mobile ? "language" : undefined}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </svg>
    </button>
  );

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={() => {
          setProjectTrustError(null);
          setProjectTrustDialogOpen(true);
        }}
        title={translate("trust.resourcesNotLoaded")}
        aria-label={translate("trust.resourcesNotLoaded")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mobileBanner ? "flex-start" : "center",
          gap: 6,
          width: mobileBanner ? "100%" : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : "100%",
          padding: mobileBanner ? "6px 12px" : "0 12px",
          background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "#d97706",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1.35,
          textAlign: "left",
        }}
        data-mobile-trust-banner={mobileBanner ? "true" : undefined}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };

  const renderChatToolbarActions = (mobile: boolean) => {
    if (!mobile && !showChat) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <button
          type="button"
          onClick={() => {
            handleViewFullHistory();
            if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
          }}
          disabled={!selectedSession}
          title={selectedSession ? translate("history.full") : translate("history.unsaved")}
          aria-label={translate("history.full")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%",
            padding: mobile ? 0 : "0 12px",
            background: "none",
            border: "none",
            borderTop: "2px solid transparent",
            borderRight: "1px solid var(--border)",
            color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
            cursor: selectedSession ? "pointer" : "not-allowed",
            opacity: selectedSession ? 1 : 0.45,
            flexShrink: 0,
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!selectedSession) return;
            event.currentTarget.style.color = "var(--text)";
            event.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
            event.currentTarget.style.background = "none";
          }}
          data-mobile-toolbar-action={mobile ? "history" : undefined}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
          {!mobile && <span>{translate("history.label")}</span>}
        </button>
        {(() => {
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !selectedSession || selectedSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
              }}
              disabled={disabled}
              title={title}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                height: "100%", padding: mobile ? 0 : "0 12px",
                background: "none", border: "none",
                borderTop: "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              data-mobile-toolbar-action={mobile ? "name" : undefined}
            >
              {autoNameStatus.kind === "naming" ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 4 5 5L7 22l-5-5Z" />
                  <path d="m14 5 5 5" />
                  <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                </svg>
              )}
              {!mobile && <span>{label}</span>}
            </button>
          );
        })()}
        {hasSubagentSessions && (
          <button
            type="button"
            onClick={() => toggleTopPanel("agents", mobile)}
            title={translate("agentSwitcher.title")}
            aria-label={translate("agentSwitcher.title")}
            aria-pressed={activeTopPanel === "agents"}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
            {!mobile && <span>{translate("agentSwitcher.title")}</span>}
            <span
              aria-hidden="true"
              style={{
                minWidth: 15, height: 15, padding: "0 4px", display: "grid", placeItems: "center",
                borderRadius: 7, background: "var(--bg-selected)", color: "var(--accent)",
                fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
                ...(mobile ? { position: "absolute", top: 2, right: 2, minWidth: 13, height: 13, padding: "0 3px", fontSize: 9 } : {}),
              }}
            >
              {activeSessionFamily!.subagents.length}
            </span>
          </button>
        )}
        {sessionHasBranches && (mobile ? (
          <button
            type="button"
            onClick={() => toggleTopPanel("branches", true)}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={activeTopPanel === "branches"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "branches" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            data-mobile-toolbar-action="branches"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: branchTree.length > 0 ? "var(--accent)" : "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        ) : (
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            inline
            containerRef={topBarRef}
            open={activeTopPanel === "branches"}
            onToggle={() => toggleTopPanel("branches")}
            hasSession
          />
        ))}
        <button
          ref={systemBtnRef}
          type="button"
          onClick={() => handleSystemInfoToggle("system", mobile)}
          disabled={mobile && !showChat}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={activeTopPanel === "system"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "system" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
          {!mobile && <span>{translate("system.label")}</span>}
        </button>
        <button
          type="button"
          onClick={() => handleSystemInfoToggle("tools", mobile)}
          disabled={mobile && !showChat}
          title={translate("tools.title")}
          aria-label={translate("tools.title")}
          aria-pressed={activeTopPanel === "tools"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "tools" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "tools" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "tools" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemTools?.some((tool) => tool.active) ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
          </svg>
          {!mobile && <span>{translate("tools.label")}</span>}
        </button>
        {mobile && renderThemeButton(true)}
        {mobile && renderLanguageButton(true)}
      </div>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!showChat || (!sessionStats && !contextUsage))) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
    const formatCompact = (value: number) => value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(0)}k`
        : String(value);
    const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

    let contextColor = "var(--text-muted)";
    let desktopContextText: string | null = null;
    let mobileContextText: string | null = null;
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      if (percent !== null && percent > 90) contextColor = "#ef4444";
      else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
      desktopContextText = percent !== null
        ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
        : `? / ${formatCompact(contextUsage.contextWindow)}`;
      mobileContextText = percent !== null ? `${percent.toFixed(0)}%` : null;
    }

    const tooltipParts: string[] = [];
    if (tokens) {
      tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
      tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
      tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
      tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      tooltipParts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    const hasMobileValues = Boolean(
      (tokens && (tokens.input > 0 || tokens.output > 0))
      || costText
      || mobileContextText,
    );

    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        disabled={!showChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        aria-hidden={covered ? true : undefined}
        className={mobile ? "mobile-session-stats" : undefined}
        data-mobile-toolbar-stats={mobile ? "true" : undefined}
        style={{
          marginLeft: mobile ? 0 : "auto",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          flex: mobile ? 1 : undefined,
          minWidth: 0,
          gap: mobile ? 7 : 10,
          paddingLeft: mobile ? 6 : 12,
          paddingRight: mobile ? 6 : 12,
          height: "100%",
          overflow: "hidden",
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {mobile ? (
          <>
            {tokens && tokens.input > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {costText && (
              <span className="mobile-session-stat-cost" style={{ color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
                {costText}
              </span>
            )}
            {mobileContextText && (
              <span style={{ color: contextColor, flexShrink: 0 }}>
                {mobileContextText}
              </span>
            )}
            {!hasMobileValues && showChat && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>
                {translate("session.title")}
              </span>
            )}
          </>
        ) : (
          <>
            {tokens && tokens.input > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {tokens && tokens.cacheRead > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                </svg>
                {formatCompact(tokens.cacheRead)}
              </span>
            )}
            {costText && (
              <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                {costText}
              </span>
            )}
            {desktopContextText && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                </svg>
                {desktopContextText}
              </span>
            )}
          </>
        )}
      </button>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    return (
      <button
        type="button"
        onClick={handleRightPanelToggle}
        disabled={covered}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        aria-hidden={covered ? true : undefined}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !mobile && !sessionStats && !contextUsage ? "auto" : 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: rightPanelOpen ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{
      display: "flex",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      overflow: "hidden",
      background: "var(--bg)",
    }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", position: "relative", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}>
          <button
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {/* Theme/language toggles moved to renderThemeButton/renderLanguageButton. */}
          <ConnectLocalMachine />
          {webUser && webUser !== "loading" && (
            <button
              type="button"
              onClick={() => setMyWorkspaceOpen(true)}
              title={translate("我的工作区：云端文件留存（建项目时可初始化 /workspace）")}
              style={{
                display: "flex", alignItems: "center", gap: 6, height: "100%",
                padding: "0 12px", background: "none",
                border: "none", borderTop: "2px solid transparent", borderRight: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", fontSize: 11,
                whiteSpace: "nowrap", flexShrink: 0,
                transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
                <polyline points="8 16 12 12 16 16" />
                <line x1="12" y1="12" x2="12" y2="21" />
              </svg>
              <span>{translate("我的工作区")}</span>
            </button>
          )}
          {webUser && webUser !== "loading" && (
            <button
              type="button"
              onClick={() => setSandboxManager({})}
              title={translate("沙箱容器管理（新建/启停/删除/快照/绑定项目）")}
              style={{
                display: "flex", alignItems: "center", gap: 6, height: "100%",
                padding: "0 12px", background: "none",
                border: "none", borderTop: "2px solid transparent", borderRight: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", fontSize: 11,
                whiteSpace: "nowrap", flexShrink: 0,
                transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 2, border: "1.5px solid currentColor", flexShrink: 0 }} />
              <span>{translate("沙箱容器")}</span>
            </button>
          )}
          {platformConsoleUrl && webUser && webUser !== "loading" && webUser.role === "admin" && (
            <button
              type="button"
              onClick={() => window.open(platformConsoleUrl, "_blank", "noopener")}
              title={translate("沙盒平台管理台（镜像/用户/配额/LLM）：{url}", { url: platformConsoleUrl })}
              style={{
                display: "flex", alignItems: "center", gap: 6, height: "100%",
                padding: "0 12px", background: "none",
                border: "none", borderTop: "2px solid transparent", borderRight: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", fontSize: 11,
                whiteSpace: "nowrap", flexShrink: 0,
                transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span>{translate("平台管理")}</span>
            </button>
          )}
          {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={translate("trust.resourcesNotLoaded")}
              aria-label={translate("trust.resourcesNotLoaded")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: "100%",
                padding: isMobile ? "0 10px" : "0 12px",
                background: "none",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: "#d97706",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
            </button>
          )}
          {isMobile && (
            <div
              ref={mobileToolbarRef}
              data-mobile-toolbar="true"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "stretch",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              {isNarrowMobile && (
                <button
                  type="button"
                  onClick={handleMobileToolbarMoreToggle}
                  title={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-label={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-controls="mobile-toolbar-actions"
                  aria-expanded={mobileToolbarMoreOpen}
                  data-mobile-toolbar-more="true"
                  style={{
                    position: "relative",
                    zIndex: mobileToolbarMoreOpen ? 21 : undefined,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                    background: mobileToolbarMoreOpen ? "var(--bg-selected)" : "none",
                    border: "none", borderRight: "1px solid var(--border)",
                    color: mobileToolbarMoreOpen ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                  }}
                >
                  {mobileToolbarMoreOpen ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                    </svg>
                  )}
                </button>
              )}
              {!isNarrowMobile && renderChatToolbarActions(true)}
              {renderSessionStatsButton(true)}
              {renderMainFileToggle(true)}
              {isNarrowMobile && mobileToolbarMoreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={translate("chat.moreControls")}
                  data-mobile-toolbar-actions="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: TOP_BAR_ICON_BUTTON_SIZE,
                    zIndex: 20,
                    display: "flex",
                    alignItems: "stretch",
                    background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                    boxShadow: "4px 0 18px rgba(0,0,0,0.12)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {renderChatToolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <>
              {renderThemeButton(false)}
              {renderLanguageButton(false)}
              {renderProjectTrustWarning(false)}
              {renderChatToolbarActions(false)}
              {renderSessionStatsButton(false)}
              {/* Platform controls: lab-training master switch + logout (multi-user). */}
              {webUser && webUser !== "loading" && webUser.role === "admin" && (
                <button
                  type="button"
                  onClick={() => {
                    const next = !labTrainingEnabled;
                    setLabTrainingEnabled(next);
                    fetch("/api/server-settings", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ labTraining: next }),
                    }).then((r) => { if (!r.ok) setLabTrainingEnabled(!next); }).catch(() => setLabTrainingEnabled(!next));
                  }}
                  title={labTrainingEnabled ? translate("教学面板：已开启（点击对全员关闭）") : translate("教学面板：已关闭（点击对全员开启）")}
                  aria-pressed={labTrainingEnabled}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, height: "100%",
                    padding: "0 10px", background: "none",
                    border: "none", borderLeft: "1px solid var(--border)",
                    color: labTrainingEnabled ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                    transition: "color 0.1s, background 0.1s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                    <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
                  </svg>
                  <span>{translate("教学")}</span>
                </button>
              )}
              {webUser && webUser !== "loading" && (
                <button
                  type="button"
                  onClick={async () => { await fetch("/api/webauth/logout", { method: "POST" }).catch(() => {}); window.location.href = "/login"; }}
                  title={translate("登出（{name}）", { name: webUser.username })}
                  aria-label={translate("登出（{name}）", { name: webUser.username })}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, height: "100%",
                    padding: "0 10px", background: "none",
                    border: "none", borderLeft: "1px solid var(--border)",
                    color: "var(--text-muted)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0,
                    transition: "color 0.1s, background 0.1s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  <span>{translate("登出")}</span>
                </button>
              )}
            </>
          )}
          {!isMobile && renderMainFileToggle(false)}
          {isMobile && sessionHasBranches && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              compact
              containerRef={topBarRef}
              open={activeTopPanel === "branches"}
              onToggle={() => toggleTopPanel("branches")}
              hasSession={showChat}
              hideInlineButton
            />
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "language" && (
                <div
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      style={{
                        display: "flex", alignItems: "center",
                        width: "100%", height: 34, padding: "0 10px",
                        border: "none", borderRadius: 4,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span>{plugin.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "agents" && activeSessionFamily && selectedSession && (
                <AgentSessionPanel
                  rootSession={activeSessionFamily.root}
                  subagents={activeSessionFamily.subagents}
                  selectedSessionId={selectedSession.id}
                  runningSessionIds={runningSessionIds}
                  onSelectSession={handleSelectSession}
                />
              )}
              {activeTopPanel === "system" && (
                <SystemPromptPanel
                  loading={systemInfoLoading}
                  prompt={systemPrompt}
                  translate={translate}
                />
              )}
              {activeTopPanel === "tools" && (
                <ToolDefinitionsPanel
                  loading={systemInfoLoading}
                  tools={systemTools}
                  translate={translate}
                />
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const ws = selectedSession;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const projectRows = [
                      ...(ws ? [{ label: translate("session.projectDir"), value: ws.projectRoot ?? ws.cwd, copyField: "projectDir" as const }] : []),
                      ...(ws?.branch ? [{ label: translate("session.gitBranch"), value: ws.branch, copyField: "gitBranch" as const }] : []),
                      ...(ws?.isWorktree ? [{ label: translate("session.gitWorktree"), value: ws.cwd, copyField: "gitWorktree" as const }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                    const projectInfoSection = projectRows.length > 0 ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {projectRows.map((row) => (
                            <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null;

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20 }}>
                          {sessionInfoSection}
                          {projectInfoSection}
                        </div>
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {/* Chat content + terminal bottom drawer */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "hidden", position: "relative", minHeight: 0 }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
              newSessionCwd={effectiveNewSessionCwd}
              newSessionMode={newSessionMode}
              newSessionProjectId={newSessionProjectId}
              newSessionDraftKey={newSessionDraftKey}
              onAgentEnd={handleAgentEnd}
              onAttentionNeeded={handleAttentionNeeded}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSystemToolsChange={handleSystemToolsChange}
              onSystemInfoLoaderChange={handleSystemInfoLoaderChange}
              onSessionStatsChange={handleSessionStatsChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onContextUsageChange={handleContextUsageChange}
              onOpenFile={handleOpenLinkedFile}
              onLabStateChange={(w, has) => { setLabWidget(w); setHasLabTraining(has); }}
              onOpenAgentsPanel={() => { setRightPanelMode("agents"); setRightPanelOpen(true); }}
              onOpenPlanPanel={() => { setRightPanelMode("plan"); setRightPanelOpen(true); }}
              planPanelActive={rightPanelMode === "plan"}
              onToggleTerminalPanel={() => {
                if (terminalDrawerMounted) setTerminalDrawerOpen((v) => !v);
                else openTerminalDrawer();
              }}
              terminalPanelActive={terminalDrawerOpen}
              remoteSession={remoteSessionCtx}
              onSubagentCallsChange={setSubagentCalls}
              sendCommandRef={sendCommandRef}
              onOpenSession={handleOpenSession}
              soundEnabled={soundEnabled}
              onSoundToggle={onSoundToggle}
              playDoneSound={playDoneSound}
              unlockAudio={unlockAudio}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
          </div>

          {/* Terminal bottom drawer — mounts on first open for the current
              session/cwd, then collapses to height 0 (PTY survives). */}
          {terminalDrawerMounted && terminalDrawerKey && (
            <div
              ref={terminalDrawerRef}
              style={{
                height: terminalDrawerOpen ? terminalDrawerHeight : 0,
                flexShrink: 0,
                overflow: "hidden",
                borderTop: terminalDrawerOpen ? "1px solid var(--border)" : "none",
                background: "#000",
                transition: "height 0.18s ease",
              }}
            >
              <div
                onMouseDown={startTerminalDrawerResize}
                onDoubleClick={() => setTerminalDrawerHeight(280)}
                title={translate("拖动调整高度（双击复位）")}
                style={{
                  height: 5, cursor: "row-resize", background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)", flexShrink: 0,
                }}
              />
              <div style={{ height: terminalDrawerOpen ? `calc(100% - 6px)` : 0 }}>
                {pendingRemoteSession ? (
                  <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, padding: 20, textAlign: "center", background: "var(--bg)" }}>
                    {translate("{kind}会话创建后（发送第一条消息）即可使用远程终端", { kind: pendingRemoteSession === "sandbox" ? translate("沙箱") : translate("本机") })}
                  </div>
                ) : (
                  <WorkspaceTerminal
                    key={terminalDrawerKey}
                    cwd={terminalDrawerKey}
                    visible={terminalDrawerOpen}
                    remote={remoteSessionCtx}
                    onClose={() => setTerminalDrawerOpen(false)}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          <button
            onClick={() => setRightPanelMode("files")}
            title={translate("文件")}
            style={{
              height: "100%", padding: "0 10px", border: "none",
              background: "transparent",
              color: rightPanelMode === "files" ? "var(--accent)" : "var(--text-dim)",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              borderBottom: rightPanelMode === "files" ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "text-bottom", marginRight: 3 }}>
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
            </svg>{translate("文件")}
          </button>
          <button
            onClick={() => { setRightPanelMode("git"); setRightPanelOpen(true); }}
            title="Git"
            style={{
              height: "100%", padding: "0 10px", border: "none",
              background: "transparent",
              color: rightPanelMode === "git" ? "var(--accent)" : "var(--text-dim)",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              borderBottom: rightPanelMode === "git" ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "text-bottom", marginRight: 3 }}>
              <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9v2c0 2-2 3-4 3H9" /><path d="M6 9v6" />
            </svg>Git
          </button>
          <button
            onClick={() => { setRightPanelMode("agents"); setRightPanelOpen(true); }}
            title={translate("子智能体目录")}
            style={{
              height: "100%", padding: "0 10px", border: "none",
              background: "transparent",
              color: rightPanelMode === "agents" ? "var(--accent)" : "var(--text-dim)",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              borderBottom: rightPanelMode === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "text-bottom", marginRight: 3 }}>
              <rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4" /><circle cx="9" cy="14" r="0.5" /><circle cx="15" cy="14" r="0.5" />
            </svg>{translate("智能体")}
          </button>
          <button
            onClick={() => { setRightPanelMode("plan"); setRightPanelOpen(true); }}
            title={translate("计划")}
            style={{
              height: "100%", padding: "0 10px", border: "none",
              background: "transparent",
              color: rightPanelMode === "plan" ? "var(--accent)" : "var(--text-dim)",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
              borderBottom: rightPanelMode === "plan" ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "text-bottom", marginRight: 3 }}>
              <path d="M9 4h6a2 2 0 0 1 2 2v14H7V6a2 2 0 0 1 2-2Z" /><path d="M7 20h10" /><path d="M10 8h4" />
            </svg>{translate("计划")}
          </button>
          <div style={{ flex: 1, overflow: "hidden" }}>
            {rightPanelMode === "files" && (
              <TabBar
                tabs={fileTabs}
                activeTabId={activeFileTabId ?? ""}
                onSelectTab={setActiveFileTabId}
                onCloseTab={handleCloseFileTab}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => setRightPanelOpen(false)}
            aria-controls="file-panel"
            aria-expanded={rightPanelOpen}
            title={translate("files.hidePanel")}
            aria-label={translate("files.hidePanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "var(--bg-selected)", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {/* Subagent directory: stays mounted while the panel is open so its
              5s record polling keeps the finished list fresh for the widget;
              keyed by session, hidden via display:none. */}
          {selectedSession?.id ? (
            <div style={{ display: rightPanelMode === "agents" ? "flex" : "none", height: "100%", flexDirection: "column" }}>
              <SubagentDirectoryPanel
                key={selectedSession.id}
                sessionId={selectedSession.id}
                subagentCalls={subagentCalls}
              />
            </div>
          ) : null}
          {rightPanelMode === "plan" ? (
            <PlanPanel cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd) ?? undefined} remote={remoteSessionCtx} />
          ) : rightPanelMode === "agents" && !selectedSession?.id ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
              {translate("选择或创建一个会话后可查看子智能体调用记录")}
            </div>
          ) : rightPanelMode === "git" ? (
            <GitPanel
              cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd) ?? ""}
              refreshKey={explorerRefreshKey}
              onClose={() => { setRightPanelMode("files"); }}
            />
          ) : rightPanelMode === "files" && activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              onDirtyChange={setActiveFileDirty}
              remote={remoteSessionCtx}
              initialState={activeFileTab.viewerState}
              watchEnabled={rightPanelOpen}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : rightPanelMode === "files" ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    {myWorkspaceOpen && <MyWorkspaceDialog onClose={() => setMyWorkspaceOpen(false)} />}
    {sandboxManager !== null && (
      <SandboxManagerDialog
        bind={sandboxManager.projectId ? { projectId: sandboxManager.projectId, projectName: sandboxManager.projectName ?? "", containerId: sandboxManager.containerId } : null}
        onClose={() => setSandboxManager(null)}
        onChanged={() => setProjectsRefreshKey((k) => k + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    {/* Skills/plugins config moved into the upstream SettingsPanel sections. */}
    {agentsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SubagentsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setAgentsConfigOpen(false)} />
    )}
    {mcpConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <McpServersConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setMcpConfigOpen(false)} />
    )}
    </>
  );
}
