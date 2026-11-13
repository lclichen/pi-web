"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListChevronsDownUp, ListChevronsUpDown, ListFilter, Pin } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { ProjectRecord } from "@/lib/projects";
import type { HostDirRecord } from "@/lib/host-dirs";
import { buildHostGroups, hostDirLabel } from "@/lib/host-groups";
import {
  anySidebarGroupExpanded,
  setAllSidebarGroups,
  sortSidebarGroups,
  type SortableSidebarGroup,
} from "@/lib/sidebar-groups";
import {
  hostPinKey,
  projectPinKey,
  SIDEBAR_SORT_STORAGE_KEY,
  SIDEBAR_UNREAD_ONLY_STORAGE_KEY,
  type SidebarPinState,
  type SidebarSortMode,
} from "@/lib/sidebar-state-shared";
import { formatRelativeTime } from "@/lib/subagent-shared";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { ProjectImportDialog } from "./ProjectImportDialog";
import { ApplyBundleDialog } from "./ApplyBundleDialog";

function loadSortMode(): SidebarSortMode {
  if (typeof window === "undefined") return "project";
  try {
    return window.localStorage.getItem(SIDEBAR_SORT_STORAGE_KEY) === "connection" ? "connection" : "project";
  } catch {
    return "project";
  }
}

function loadUnreadOnly(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_UNREAD_ONLY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

interface Props {
  sessions: SessionInfo[];
  runningSessionIds: Set<string>;
  /** Sessions completed in the background since the user last opened them. */
  unreadSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onNewSessionInProject: (project: ProjectRecord) => void;
  /** Host 空间：在指定服务器目录创建/打开会话。 */
  onNewSessionInDirectory?: (directory: string) => void;
  /** 快速会话空间：从指定模板新建会话（模板组头部的 ＋ 按钮）。 */
  onNewSessionFromTemplate?: (templateId: string, templateName: string) => void;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  refreshSessions: () => void;
  isAdmin: boolean;
  /** mine = 项目会话；quick = 快速会话聚合（无工作区）；host = CLI/服务器目录（admin）。 */
  sessionSpace: "mine" | "host" | "quick";
  onSessionSpaceChange?: (space: "mine" | "host" | "quick") => void;
  onOpenServerDirectory?: () => void;
  /** Open the sandbox manager dialog bound to a project (sandbox mode). */
  onManageSandbox?: (project: ProjectRecord) => void;
  /** Bump to force a project-list reload (e.g. container rebound elsewhere). */
  projectsRefreshKey?: number;
}

const RECENT_COUNT = 5;
const COLLAPSE_KEY = "pi-web:project-tree-collapsed";

/**
 * Two-level session tree for multi-user mode: first level = projects
 * (created-time sorted, config carriers), second level = that project's
 * sessions (pinned first, then the 5 most recent, "显示全部" expands).
 * Host-space sessions (admin) group dynamically by projectRoot below.
 */
const useT = () => useI18n().t;

export function ProjectSessionTree({
  sessions,
  runningSessionIds,
  unreadSessionIds,
  selectedSessionId,
  onSelectSession,
  onNewSessionInProject,
  onNewSessionInDirectory,
  onNewSessionFromTemplate,
  onDeleteSession,
  onRenameSession,
  refreshSessions,
  isAdmin,
  sessionSpace,
  onSessionSpaceChange,
  onOpenServerDirectory,
  onManageSandbox,
  projectsRefreshKey,
}: Props) {
  const t = useT();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  // Host 目录注册表：让"新建 Host 项目"在没有会话时也能显示一个空组。
  // 只影响侧栏占位；会话仍按 cwd 动态聚合，不绑定 projectId。
  const [hostDirs, setHostDirs] = useState<HostDirRecord[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Host 目录组不是持久化的 ProjectRecord，菜单按 directory 分发。
  const [menu, setMenu] = useState<{ project?: ProjectRecord; directory?: string; x: number; y: number } | null>(null);
  const [pins, setPins] = useState<SidebarPinState>({ pinnedProjects: [], pinnedSessions: [] });
  const [sortMode, setSortMode] = useState<SidebarSortMode>(loadSortMode);
  const [unreadOnly, setUnreadOnly] = useState(loadUnreadOnly);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [applyBundleId, setApplyBundleId] = useState<string | null>(null);
  const [hostImportDir, setHostImportDir] = useState<string | null>(null);
  /** Host 目录套用配置模板（仅未初始化目录；服务端 .pi 预检 409）。 */
  const [applyHostDir, setApplyHostDir] = useState<string | null>(null);
  const [containers, setContainers] = useState<Array<{ id: number; name: string; status: string; imageName: string }>>(
    [],
  );
  const [newDialog, setNewDialog] = useState<"sandbox" | "local-machine" | null>(null);
  const [myWorkspaceId, setMyWorkspaceId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const viewMenuRef = useRef<HTMLDivElement | null>(null);

  const pinnedProjectKeys = useMemo(() => new Set(pins.pinnedProjects), [pins.pinnedProjects]);
  const pinnedSessionKeys = useMemo(() => new Set(pins.pinnedSessions), [pins.pinnedSessions]);
  const pinRankByProjectKey = useMemo(
    () => new Map(pins.pinnedProjects.map((key, index) => [key, index])),
    [pins.pinnedProjects],
  );

  const loadPins = useCallback(() => {
    fetch("/api/sidebar-state")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SidebarPinState | null) => {
        if (!d) return;
        setPins({
          pinnedProjects: Array.isArray(d.pinnedProjects) ? d.pinnedProjects : [],
          pinnedSessions: Array.isArray(d.pinnedSessions) ? d.pinnedSessions : [],
        });
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadPins();
  }, [loadPins]);

  const applyPin = useCallback(
    async (patch: { projectKey?: string; sessionId?: string; pinned: boolean }) => {
      try {
        const res = await fetch("/api/sidebar-state", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = (await res.json().catch(() => null)) as SidebarPinState | null;
        if (!res.ok || !data) return false;
        setPins({
          pinnedProjects: Array.isArray(data.pinnedProjects) ? data.pinnedProjects : [],
          pinnedSessions: Array.isArray(data.pinnedSessions) ? data.pinnedSessions : [],
        });
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const toggleProjectPin = useCallback(
    (projectKey: string, pinned: boolean) => void applyPin({ projectKey, pinned }),
    [applyPin],
  );
  const toggleSessionPin = useCallback(
    (sessionId: string, pinned: boolean) => void applyPin({ sessionId, pinned }),
    [applyPin],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_SORT_STORAGE_KEY, sortMode);
    } catch {
      // Private mode: applies to this mount only.
    }
  }, [sortMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_UNREAD_ONLY_STORAGE_KEY, unreadOnly ? "1" : "0");
    } catch {
      // Private mode: applies to this mount only.
    }
  }, [unreadOnly]);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setViewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [viewMenuOpen]);

  const loadProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d: { projects?: ProjectRecord[] }) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadProjects();
  }, [loadProjects, projectsRefreshKey]);

  // Host 目录注册表（admin-only；非管理员接口 403 → 空列表）。
  const loadHostDirs = useCallback(() => {
    if (!isAdmin) {
      setHostDirs([]);
      return;
    }
    fetch("/api/host/dirs")
      .then((r) => (r.ok ? r.json() : { dirs: [] }))
      .then((d: { dirs?: HostDirRecord[] }) => setHostDirs(d.dirs ?? []))
      .catch(() => setHostDirs([]));
  }, [isAdmin]);
  useEffect(() => {
    loadHostDirs();
  }, [loadHostDirs, projectsRefreshKey]);

  // Container list: status dots on project nodes + the container picker.
  const loadContainers = useCallback(() => {
    fetch("/api/sandbox/containers")
      .then((r) => (r.ok ? r.json() : { containers: [] }))
      .then((d: { containers?: Array<{ id: number; name: string; status: string; imageName: string }> }) =>
        setContainers(d.containers ?? []),
      )
      .catch(() => setContainers([]));
  }, []);
  useEffect(() => {
    loadContainers();
  }, [loadContainers, projectsRefreshKey]);
  useEffect(() => {
    if (menu?.project?.mode === "sandbox") loadContainers();
  }, [menu, loadContainers]);

  // My cloud workspace (for export-to-workspace); lazily ensured server-side.
  useEffect(() => {
    fetch("/api/workspaces")
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d: { workspaces?: Array<{ id: number }> }) => setMyWorkspaceId(d.workspaces?.[0]?.id ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const duplicate = async (project: ProjectRecord) => {
    await fetch(`/api/projects/${encodeURIComponent(project.id)}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => {});
    loadProjects();
  };

  // 导出配置包：拉 zip blob 触发浏览器下载（.pi/ 配置 + labs/，凭证已剥离）。
  const exportConfig = async (project: ProjectRecord) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/config-export`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(data.error ?? `导出失败（HTTP ${res.status}）`);
        return;
      }
      const blob = await res.blob();
      const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_").trim() || "project";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-config.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.alert(t("sessions.exportFailedRetry"));
    }
  };

  // Host 目录配置包导出：cwd 走查询串，服务端按 host 根栅栏校验（admin）。
  const exportHostConfig = async (dir: string) => {
    try {
      const res = await fetch(`/api/host/config-export?cwd=${encodeURIComponent(dir)}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(data.error ?? `导出失败（HTTP ${res.status}）`);
        return;
      }
      const blob = await res.blob();
      const base = dir.replace(/\/+$/g, "").split("/").filter(Boolean).pop() || "directory";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}-config.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.alert(t("sessions.exportFailedRetry"));
    }
  };
  // 工作区 .pi/ → 项目区配置同步：先 dry-run 做同样的安全/模式校验并拿到
  // 差异摘要，用户确认后再落盘；凭证与运行态文件由服务端跳过。
  const syncWorkspaceConfig = async (project: ProjectRecord) => {
    const url = `/api/projects/${encodeURIComponent(project.id)}/workspace-config-sync`;
    try {
      const previewRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const preview = (await previewRes.json().catch(() => ({}))) as {
        error?: string;
        stats?: { files: number; added: number; overwritten: number; unchanged: number; skipped: number };
        trust?: { requiresTrust: boolean; trusted: boolean };
      };
      if (!previewRes.ok || preview.error || !preview.stats) {
        window.alert(preview.error ?? t("sessions.operationFailedHttp", { code: previewRes.status }));
        return;
      }
      const stats = preview.stats;
      const lines = [
        t("sessions.workspaceSyncConfirm", {
          files: stats.files,
          added: stats.added,
          overwritten: stats.overwritten,
          unchanged: stats.unchanged,
        }),
      ];
      if (stats.skipped > 0) lines.push(t("sessions.workspaceSyncSkipped", { count: stats.skipped }));
      if (preview.trust?.requiresTrust && !preview.trust.trusted) {
        lines.push(t("sessions.workspaceSyncTrustNeeded"));
      }
      if (!window.confirm(lines.join("\n\n"))) return;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        stats?: { added: number; overwritten: number; unchanged: number };
        trust?: { requiresTrust: boolean; trusted: boolean };
      };
      if (!res.ok || data.error || !data.stats) {
        window.alert(data.error ?? t("sessions.operationFailedHttp", { code: res.status }));
        return;
      }
      let message = t("sessions.workspaceSyncDone", {
        added: data.stats.added,
        overwritten: data.stats.overwritten,
        unchanged: data.stats.unchanged,
      });
      if (data.trust?.requiresTrust && !data.trust.trusted) {
        message += `\n\n${t("sessions.workspaceSyncTrustNeeded")}`;
      }
      window.alert(message);
      // 同步可能引入扩展/技能/MCP → 让宿主立即重查信任状态。
      window.dispatchEvent(new Event("pi-web:config-changed"));
    } catch {
      window.alert(t("sessions.workspaceSyncFailed"));
    }
  };

  const remove = async (project: ProjectRecord) => {
    if (!window.confirm(t("sessions.deleteProjectConfirm", { name: project.name }))) return;
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(() => {});
    loadProjects();
    refreshSessions();
  };

  // Host 项目区临时附件（.pi/attachments）：先算占用，再确认清理。
  const cleanAttachments = async (project: ProjectRecord) => {
    const base = `/api/projects/${encodeURIComponent(project.id)}/attachments`;
    try {
      const res = await fetch(base);
      const data = (await res.json().catch(() => ({}))) as { bytes?: number; files?: number; error?: string };
      if (!res.ok) {
        window.alert(data.error ?? t("sessions.operationFailedHttp", { code: res.status }));
        return;
      }
      const bytes = data.bytes ?? 0;
      const files = data.files ?? 0;
      if (bytes <= 0) {
        window.alert(t("sessions.cleanAttachmentsEmpty"));
        return;
      }
      const size = formatSize(bytes);
      if (
        !window.confirm(
          t("sessions.cleanAttachmentsConfirm", { name: project.name, size, count: files }),
        )
      ) {
        return;
      }
      const del = await fetch(base, { method: "DELETE" });
      const removed = (await del.json().catch(() => ({}))) as { bytes?: number; files?: number; error?: string };
      if (!del.ok) {
        window.alert(removed.error ?? t("sessions.operationFailedHttp", { code: del.status }));
        return;
      }
      window.alert(
        t("sessions.cleanAttachmentsDone", {
          size: formatSize(removed.bytes ?? bytes),
          count: removed.files ?? files,
        }),
      );
    } catch {
      window.alert(t("sessions.cleanAttachmentsFailed"));
    }
  };

  const setContainer = async (project: ProjectRecord, containerId: number | null) => {
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containerId }),
    }).catch(() => {});
    loadProjects();
    setMenu(null);
  };

  // 项目快照槽（游戏存档制：保存/恢复/删除，服务端做 FIFO 淘汰）。
  const [menuBusy, setMenuBusy] = useState(false);
  const projectSnapshot = async (
    project: ProjectRecord,
    action: "save" | "restore" | "delete",
    snapshotId?: number,
  ) => {
    if (menuBusy) return;
    if (action === "restore" && !window.confirm(t("sessions.restoreSaveConfirm"))) return;
    setMenuBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(snapshotId != null ? { snapshotId } : {}) }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        window.alert(d?.error ?? t("sessions.operationFailedHttp", { code: res.status }));
        return;
      }
      if (action === "save") window.alert(t("sessions.saveCreatedLast2Kept"));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setMenuBusy(false);
    }
    loadProjects();
    loadContainers();
  };

  // 把项目容器的 /workspace 打包导出到我的工作区（tar.gz，单向留存）。
  const exportWorkspace = async (project: ProjectRecord) => {
    if (menuBusy) return;
    if (project.containerId == null) {
      window.alert(t("sessions.projectBoundContainer"));
      return;
    }
    if (myWorkspaceId == null) {
      window.alert(t("sessions.cloudWorkspaceUnavailable"));
      return;
    }
    setMenuBusy(true);
    try {
      const res = await fetch(`/api/sandbox/containers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "export-workspace",
          containerId: project.containerId,
          workspaceId: myWorkspaceId,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; fileName?: string };
      if (!res.ok) {
        window.alert(d?.error ?? t("sessions.exportFailedHttp", { code: res.status }));
        return;
      }
      window.alert(t("sessions.exportedMyWorkspaceFilesOnly", { file: d.fileName ?? "*.tar.gz" }));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setMenuBusy(false);
    }
  };

  // Unread-only applies before grouping, so empty projects/directories drop
  // out of the list instead of leaving a skeleton of headers.
  const baseSessions = useMemo(() => {
    if (!unreadOnly) return sessions;
    const visibleParents = new Set<string>();
    for (const s of sessions) {
      if (s.relation?.kind === "subagent") continue;
      if (unreadSessionIds.has(s.id)) visibleParents.add(s.id);
    }
    return sessions.filter((s) =>
      s.relation?.kind === "subagent"
        ? visibleParents.has(s.relation.parentSessionId)
        : visibleParents.has(s.id),
    );
  }, [sessions, unreadOnly, unreadSessionIds]);

  // Pinned sessions move out of their project/Host directory group into one
  // "Pinned" section above everything; their subagent children ride along.
  const pinnedSessions = useMemo(() => {
    const order = new Map(pins.pinnedSessions.map((id, index) => [id, index]));
    return baseSessions
      .filter((s) => s.relation?.kind !== "subagent" && pinnedSessionKeys.has(s.id))
      .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [baseSessions, pinnedSessionKeys, pins.pinnedSessions]);

  const groupSessions = useMemo(
    () => baseSessions.filter((s) => !pinnedSessionKeys.has(s.id)),
    [baseSessions, pinnedSessionKeys],
  );

  // Group sessions by project; ungrouped (host-mode/CLI) by projectRoot.
  // Quick sessions (no workspace, no project) are partitioned out entirely —
  // they render in their own "quick" space tab and must never leak into
  // project groups or admin host-directory groups.
  const byProject = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    const ungrouped: SessionInfo[] = [];
    for (const s of groupSessions) {
      if (s.mode === "quick") continue;
      // 子智能体会话不带 projectId/mode 元数据，未绑定分组会把它们归进
      // "未知来源"——排除后经 subagentChildren 嵌套在父行下渲染。
      if (s.relation?.kind === "subagent") continue;
      if (s.projectId) {
        const list = map.get(s.projectId) ?? [];
        list.push(s);
        map.set(s.projectId, list);
      } else {
        ungrouped.push(s);
      }
    }
    for (const list of map.values()) list.sort((a, b) => b.modified.localeCompare(a.modified));
    ungrouped.sort((a, b) => b.modified.localeCompare(a.modified));
    return { map, ungrouped };
  }, [groupSessions]);

  // 子会话按父会话 id 索引——父行落在哪个组（项目/Host 目录/未绑定/置顶），
  // 子行就缩进渲染在它下面。父会话不在当前列表时子会话随之隐藏：它们
  // 是一个家族，不是独立会话。
  const subagentChildren = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of baseSessions) {
      if (s.relation?.kind !== "subagent") continue;
      const parent = s.relation.parentSessionId;
      const list = map.get(parent) ?? [];
      list.push(s);
      map.set(parent, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.modified.localeCompare(a.modified));
    return map;
  }, [baseSessions]);

  // Quick-space two-level tree: group by template VERSION (quickGroupKey =
  // "<templateId>@<hash>", derived server-side from the workspace snapshot).
  // Same template at different content versions = different groups, mirroring
  // how the workspace directories are laid out. Detached groups (template
  // deleted, snapshot remains) keep their sessions and refuse new ones.
  // Sessions predating the snapshot metadata fall into one legacy bucket.
  const quickGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        name: string;
        hash?: string;
        templateId?: string;
        detached: boolean;
        sessions: SessionInfo[];
      }
    >();
    for (const s of groupSessions) {
      if (s.mode !== "quick") continue;
      const key = s.quickGroupKey ?? "__unassigned";
      let group = groups.get(key);
      if (!group) {
        const meta = s.quickTemplate;
        group = {
          key,
          name: meta?.name ?? "",
          hash: meta?.hash,
          templateId: meta?.id,
          detached: Boolean(meta?.detached),
          sessions: [],
        };
        groups.set(key, group);
      }
      // Meta comes from the same snapshot for the whole group; prefer a
      // non-detached reading only for robustness against mixed snapshots.
      if (!group.name && s.quickTemplate?.name) group.name = s.quickTemplate.name;
      group.sessions.push(s);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        sessions: group.sessions.sort((a, b) => b.modified.localeCompare(a.modified)),
      }))
      .sort((a, b) => b.sessions[0]?.modified.localeCompare(a.sessions[0]?.modified ?? "") ?? 0);
  }, [groupSessions]);

  // 管理员通过"打开服务器目录"（host 模式）建的会话没有 projectId，按目录
  // 动态分组显示——不区分 mine/host 空间（UI 没有空间切换入口，之前 gate
  // 在 sessionSpace==="host" 上导致这些会话永远不显示）。
  // 非宿主模式的未绑定会话（API 直建的 pre-project sandbox 会话等）单独成组、
  // 带各自模式徽标——混进 Host 目录组会让"项目=Host / 会话=沙箱"两个徽标打架。
  const hostGroups = useMemo(
    () => (isAdmin ? buildHostGroups(byProject.ungrouped, hostDirs) : []),
    [byProject.ungrouped, isAdmin, hostDirs],
  );

  // 目录根 → 注册记录（显示名/菜单用）。
  const hostDirByRoot = useMemo(() => new Map(hostDirs.map((d) => [d.root, d])), [hostDirs]);

  // Latest activity per project/Host root, including pinned sessions, so
  // pinning a session never changes where its project sorts.
  const latestByProject = useMemo(() => {
    const latest = new Map<string, string>();
    for (const s of sessions) {
      if (!s.projectId) continue;
      if (!latest.has(s.projectId) || s.modified > latest.get(s.projectId)!) latest.set(s.projectId, s.modified);
    }
    return latest;
  }, [sessions]);

  const latestByHostRoot = useMemo(() => {
    const latest = new Map<string, string>();
    for (const s of sessions) {
      if (s.projectId || s.mode !== "host") continue;
      const root = s.projectRoot ?? s.cwd;
      if (!latest.has(root) || s.modified > latest.get(root)!) latest.set(root, s.modified);
    }
    return latest;
  }, [sessions]);

  const orderedProjects = useMemo(() => {
    const items = projects.map((project) => {
      const key = projectPinKey(project.id);
      return {
        key,
        name: project.name,
        mode: project.mode,
        latest: latestByProject.get(project.id) ?? "",
        pinned: pinnedProjectKeys.has(key),
        pinRank: pinRankByProjectKey.get(key) ?? -1,
        project,
      };
    });
    return sortSidebarGroups(items, sortMode).map((item) => item.project);
  }, [latestByProject, pinRankByProjectKey, pinnedProjectKeys, projects, sortMode]);

  const orderedHostGroups = useMemo(() => {
    const items = hostGroups.map(([root, list]) => {
      const key = hostPinKey(root);
      return {
        key,
        name: hostDirByRoot.get(root)?.name?.trim() || hostDirLabel(root),
        mode: "host",
        latest: latestByHostRoot.get(root) ?? "",
        pinned: pinnedProjectKeys.has(key),
        pinRank: pinRankByProjectKey.get(key) ?? -1,
        root,
        list,
      };
    });
    return sortSidebarGroups(items, sortMode).map((item) => [item.root, item.list] as [string, SessionInfo[]]);
  }, [hostDirByRoot, hostGroups, latestByHostRoot, pinRankByProjectKey, pinnedProjectKeys, sortMode]);

  // 未绑定项目的非宿主模式会话，按 mode 聚成一组（沙箱/本机/SSH 各一组）。
  const unboundModeGroups = useMemo(() => {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of byProject.ungrouped) {
      if (!s.mode || s.mode === "host") continue;
      const list = groups.get(s.mode) ?? [];
      list.push(s);
      groups.set(s.mode, list);
    }
    for (const list of groups.values()) list.sort((a, b) => b.modified.localeCompare(a.modified));
    return [...groups.entries()];
  }, [byProject.ungrouped]);

  // One order across platform projects, Host directory groups and unbound
  // session groups. The groups stay separate render blocks (they have very
  // different headers), but the flex container's `order` interleaves them so
  // "project first"/"connection first" also move Host groups instead of
  // leaving them pinned to the bottom.
  const groupRenderOrder = useMemo(() => {
    const entries: Array<SortableSidebarGroup & { kind: "project" | "host" | "unbound" }> = [];
    if (sessionSpace === "mine") {
      for (const project of projects) {
        const key = project.id;
        entries.push({
          key,
          name: project.name,
          mode: project.mode,
          latest: latestByProject.get(project.id) ?? "",
          pinned: pinnedProjectKeys.has(projectPinKey(project.id)),
          pinRank: pinRankByProjectKey.get(projectPinKey(project.id)) ?? -1,
          kind: "project",
        });
      }
    }
    if (sessionSpace !== "quick") {
      for (const [root] of hostGroups) {
        const key = hostPinKey(root);
        entries.push({
          key,
          name: hostDirByRoot.get(root)?.name?.trim() || hostDirLabel(root),
          mode: "host",
          latest: latestByHostRoot.get(root) ?? "",
          pinned: pinnedProjectKeys.has(key),
          pinRank: pinRankByProjectKey.get(key) ?? -1,
          kind: "host",
        });
      }
      for (const [mode, list] of unboundModeGroups) {
        entries.push({
          key: `unbound:${mode}`,
          name: mode,
          mode,
          latest: list[0]?.modified ?? "",
          pinned: false,
          pinRank: -1,
          kind: "unbound",
        });
      }
    }
    return new Map(sortSidebarGroups(entries, sortMode).map((entry, index) => [entry.key, index]));
  }, [
    hostDirByRoot,
    hostGroups,
    latestByHostRoot,
    latestByProject,
    pinRankByProjectKey,
    pinnedProjectKeys,
    projects,
    sessionSpace,
    sortMode,
    unboundModeGroups,
  ]);

  const renderItem = (s: SessionInfo) => {
    const selected = s.id === selectedSessionId;
    const running = runningSessionIds.has(s.id);
    const pinned = pinnedSessionKeys.has(s.id);
    const children = subagentChildren.get(s.id);
    return (
      <div key={s.id}>
        <ProjectSessionRow
          session={s}
          selected={selected}
          running={running}
          unread={unreadSessionIds.has(s.id)}
          pinned={pinned}
          canPin
          onSelect={() => onSelectSession(s)}
          onRename={(name) => void onRenameSession(s.id, name)}
          onDelete={() => void onDeleteSession(s.id)}
          onTogglePin={() => toggleSessionPin(s.id, !pinned)}
        />
        {children?.map((child) => (
          <ProjectSessionRow
            key={child.id}
            session={child}
            nested
            selected={child.id === selectedSessionId}
            running={runningSessionIds.has(child.id)}
            unread={unreadSessionIds.has(child.id)}
            pinned={false}
            canPin={false}
            onSelect={() => onSelectSession(child)}
            onRename={(name) => void onRenameSession(child.id, name)}
            onDelete={() => void onDeleteSession(child.id)}
            onTogglePin={() => {}}
          />
        ))}
      </div>
    );
  };

  const projectSessions = (project: ProjectRecord): { visible: SessionInfo[]; total: number } => {
    const all = byProject.map.get(project.id) ?? [];
    const expandedAll = showAll.has(project.id);
    return { visible: expandedAll ? all : all.slice(0, RECENT_COUNT), total: all.length };
  };

  const expandableGroupKeys = useMemo(() => {
    const keys: string[] = [];
    if (sessionSpace === "mine") {
      for (const project of orderedProjects) {
        if ((byProject.map.get(project.id)?.length ?? 0) > 0) keys.push(project.id);
      }
    }
    if (sessionSpace !== "quick") {
      for (const [root, list] of orderedHostGroups) {
        if (list.length > 0) keys.push(`host:${root}`);
      }
      for (const [mode, list] of unboundModeGroups) {
        if (list.length > 0) keys.push(`unbound:${mode}`);
      }
    }
    if (sessionSpace === "quick") {
      for (const group of quickGroups) {
        if (group.sessions.length > 0) keys.push(`quick:${group.key}`);
      }
    }
    return keys;
  }, [byProject.map, orderedHostGroups, orderedProjects, quickGroups, sessionSpace, unboundModeGroups]);

  // 全局会话搜索：按名称/首条消息/id 过滤全部会话，平铺显示（含所属项目标记）。
  const searching = query.trim().length > 0;
  const allSessionsSorted = useMemo(
    () => [...baseSessions].sort((a, b) => b.modified.localeCompare(a.modified)),
    [baseSessions],
  );
  const searchResults = useMemo(() => {
    if (!searching) return [] as SessionInfo[];
    const q = query.trim().toLowerCase();
    return allSessionsSorted
      .filter(
        (s) =>
          s.name?.toLowerCase().includes(q) ||
          s.firstMessage.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [searching, query, allSessionsSorted]);

  const anyGroupExpanded = anySidebarGroupExpanded(expandableGroupKeys, collapsed);
  const toggleAllGroups = useCallback(() => {
    const next = setAllSidebarGroups(collapsed, expandableGroupKeys, anyGroupExpanded);
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
    } catch {
      // Private mode: applies to this mount only.
    }
  }, [anyGroupExpanded, collapsed, expandableGroupKeys]);
  const hasVisibleTopLevelSession = baseSessions.some((s) => s.relation?.kind !== "subagent");
  const collapseButtonDisabled = searching || expandableGroupKeys.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 4px" }}>
      {/* 空间切换：我的项目会话 ↔ 快速会话（所有人）↔ Host 空间（admin）。
          快速会话没有项目/工作区，独立成第三个平级空间，避免混进项目列表。 */}
      {onSessionSpaceChange && !searching && (
        <div
          style={{
            display: "flex",
            gap: 0,
            padding: "0 4px 8px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            overflow: "hidden",
            fontSize: 11,
          }}
        >
          {(["mine", "quick", ...(isAdmin ? (["host"] as const) : [])] as const).map((space) => {
            const active = sessionSpace === space;
            return (
              <button
                key={space}
                type="button"
                onClick={() => onSessionSpaceChange(space)}
                title={
                  space === "host"
                    ? t("sessions.hostSessionsCreatedPiCli")
                    : space === "quick"
                      ? t("sessions.quickSessionsHint")
                      : t("sessions.myProjectSessions")
                }
                style={{
                  flex: 1,
                  padding: "4px 0",
                  border: "none",
                  cursor: "pointer",
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-dim)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {space === "mine"
                  ? t("sessions.mySessions")
                  : space === "quick"
                    ? `⚡ ${t("sessions.quick")}`
                    : "Host (CLI)"}
              </button>
            );
          })}
        </div>
      )}

      {/* 全局会话搜索 + 视图/排序 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 4px 8px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder={t("sessions.searchSessions")}
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: "border-box",
            height: 26,
            padding: "0 8px",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            outline: "none",
          }}
        />
        <button
          type="button"
          aria-label={anyGroupExpanded ? t("sessions.collapseAllProjects") : t("sessions.expandAllProjects")}
          title={anyGroupExpanded ? t("sessions.collapseAllProjects") : t("sessions.expandAllProjects")}
          onClick={toggleAllGroups}
          disabled={collapseButtonDisabled}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            padding: 0,
            flexShrink: 0,
            border: "1px solid var(--border)",
            borderRadius: 5,
            background: "transparent",
            color: "var(--text-muted)",
            cursor: collapseButtonDisabled ? "not-allowed" : "pointer",
            opacity: collapseButtonDisabled ? 0.4 : 1,
          }}
        >
          {anyGroupExpanded ? <ListChevronsDownUp size={14} /> : <ListChevronsUpDown size={14} />}
        </button>
        <div ref={viewMenuRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            aria-label={t("sessions.viewOptions")}
            title={t("sessions.viewOptions")}
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
            onClick={() => setViewMenuOpen((open) => !open)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              position: "relative",
              border: `1px solid ${viewMenuOpen ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 5,
              background: viewMenuOpen ? "var(--bg-selected)" : "transparent",
              color: viewMenuOpen ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <ListFilter size={14} />
            {unreadOnly && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: 3,
                  right: 3,
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  background: "var(--accent)",
                }}
              />
            )}
          </button>
          {viewMenuOpen && (
            <div
              role="menu"
              aria-label={t("sessions.viewOptions")}
              style={{
                position: "absolute",
                top: 30,
                right: 0,
                zIndex: 1200,
                minWidth: 190,
                padding: 4,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                fontSize: 12,
              }}
            >
              <div style={{ padding: "4px 8px 2px", fontSize: 10, color: "var(--text-dim)" }}>
                {t("sessions.sortLabel")}
              </div>
              {(["project", "connection"] as SidebarSortMode[]).map((mode) => {
                const active = sortMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => {
                      setSortMode(mode);
                      setViewMenuOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "6px 8px",
                      background: "transparent",
                      border: "none",
                      borderRadius: 5,
                      color: active ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ width: 12, flexShrink: 0, color: "var(--accent)" }}>{active ? "✓" : ""}</span>
                    <span>
                      {mode === "project"
                        ? t("sessions.sortProjectFirst")
                        : t("sessions.sortConnectionFirst")}
                    </span>
                  </button>
                );
              })}
              <div style={{ borderTop: "1px solid var(--border)", margin: "3px 0" }} />
              <div style={{ padding: "4px 8px 2px", fontSize: 10, color: "var(--text-dim)" }}>
                {t("sessions.filterLabel")}
              </div>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={unreadOnly}
                onClick={() => setUnreadOnly((value) => !value)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "6px 8px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 5,
                  color: unreadOnly ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 12,
                    height: 12,
                    flexShrink: 0,
                    borderRadius: 3,
                    border: `1px solid ${unreadOnly ? "var(--accent)" : "var(--border)"}`,
                    background: unreadOnly ? "var(--accent)" : "transparent",
                    color: "var(--bg)",
                    fontSize: 9,
                    fontWeight: 700,
                  }}
                >
                  {unreadOnly ? "✓" : ""}
                </span>
                <span>{t("sessions.unreadOnly")}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {searching && (
        <div>
          {searchResults.length === 0 ? (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("sessions.matchingSessions")}
            </div>
          ) : (
            searchResults.map((s) => {
              const owner = projects.find((p) => p.id === s.projectId) ?? null;
              return (
                <div key={`search:${s.id}`} style={{ marginBottom: 2 }}>
                  <div style={{ padding: "2px 8px", fontSize: 10, color: "var(--text-dim)" }}>
                    {owner
                      ? t("sessions.project", { name: owner.name })
                      : s.mode === "quick"
                        ? `⚡ ${t("sessions.quick")}`
                        : (s.projectRoot ?? t("sessions.ungrouped"))}
                  </div>
                  {renderItem(s)}
                </div>
              );
            })
          )}
        </div>
      )}

      {!searching && (
        <>
          {/* 已置顶会话：跨项目/Host 目录统一浮到项目区上方；原分组里不再重复。 */}
          {pinnedSessions.length > 0 && (
            <div style={{ marginBottom: 2 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 6px",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                <Pin size={11} aria-hidden="true" />
                <span>{t("sessions.pinned")}</span>
                <span style={{ marginLeft: "auto", fontSize: 10 }}>{pinnedSessions.length}</span>
              </div>
              {pinnedSessions.map((s) => renderItem(s))}
            </div>
          )}
          {unreadOnly && !hasVisibleTopLevelSession && (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("sessions.noUnreadSessions")}
            </div>
          )}

          {/* 项目列表只属于“我的会话”空间：Host(CLI) 是 CLI/服务器目录会话的
          专用视图，混入平台项目组（多为空态）只会稀释真正的 CLI 分组；
          项目的浏览/管理入口在“我的会话”一侧。 */}
          {sessionSpace === "mine" &&
            orderedProjects
              .filter((project) => !unreadOnly || (byProject.map.get(project.id)?.length ?? 0) > 0)
              .map((project) => {
              const { visible, total } = projectSessions(project);
              const isCollapsed = collapsed.has(project.id);
              const projectPinned = pinnedProjectKeys.has(projectPinKey(project.id));
              const projectHasPinnedSessions = pinnedSessions.some((s) => s.projectId === project.id);
              // 焦点会话所属项目高亮 + 左侧模式色条，一眼定位当前所在项目。
              const projectHoldsFocus = Boolean(
                selectedSessionId && byProject.map.get(project.id)?.some((s) => s.id === selectedSessionId),
              );
              const modeColor = project.mode === "sandbox" ? "#38bdf8" : project.mode === "ssh" ? "#34d399" : "#a78bfa";
              // 容器状态点（沙箱项目绑定容器的前台可见性）。
              const bound =
                project.containerId != null ? containers.find((c) => c.id === project.containerId) : undefined;
              const containerState =
                bound?.status === "running"
                  ? { color: "#22c55e", label: t("projects.running") }
                  : bound?.status === "stopped"
                    ? { color: "#9ca3af", label: t("projects.stopped") }
                    : bound
                      ? { color: "#f59e0b", label: bound.status }
                      : { color: "#ef4444", label: t("sessions.container2") };
              return (
                <div key={project.id} style={{ marginBottom: 2, order: groupRenderOrder.get(project.id) ?? 0 }}>
                  <div
                    onClick={() => toggleCollapsed(project.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 6px",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text)",
                      background: projectHoldsFocus ? "var(--bg-selected)" : "var(--bg-panel)",
                      boxShadow: projectHoldsFocus ? `inset 2px 0 0 ${modeColor}` : "none",
                    }}
                    onMouseEnter={(e) => {
                      if (!projectHoldsFocus) e.currentTarget.style.background = "var(--bg-selected)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = projectHoldsFocus ? "var(--bg-selected)" : "var(--bg-panel)";
                    }}
                  >
                    <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
                    {project.mode === "sandbox" ? (
                      <span
                        title={t("sessions.container", {
                          info: bound
                            ? `#${bound.id} ${bound.name} · ${containerState.label}${bound.imageName ? ` · ${bound.imageName}` : ""}`
                            : containerState.label,
                        })}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: containerState.color,
                          flexShrink: 0,
                          boxShadow: containerState.label === "运行中" ? `0 0 5px ${containerState.color}` : "none",
                        }}
                      />
                    ) : (
                      <span style={{ width: 8, height: 8, flexShrink: 0 }} />
                    )}
                    <span
                      style={{
                        flexShrink: 0,
                        padding: "0 5px",
                        borderRadius: 3,
                        fontSize: 9,
                        fontWeight: 700,
                        color: modeColor,
                        background:
                          project.mode === "sandbox"
                            ? "rgba(56,189,248,0.12)"
                            : project.mode === "ssh"
                              ? "rgba(52,211,153,0.14)"
                              : "rgba(167,139,250,0.12)",
                      }}
                    >
                      {project.mode === "sandbox"
                        ? t("sessions.sandbox")
                        : project.mode === "ssh"
                          ? t("SSH")
                          : t("sessions.local")}
                    </span>
                    {projectPinned && (
                      <Pin size={11} fill="currentColor" style={{ color: "#f59e0b", flexShrink: 0 }} aria-hidden="true" />
                    )}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {project.name}
                    </span>
                    {project.mode === "sandbox" && (
                      <span
                        title={t("sessions.runInsideContainer")}
                        style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)" }}
                      >
                        /workspace
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{total}</span>
                    <button
                      type="button"
                      title={t("sessions.newSession")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewSessionInProject(project);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-dim)",
                        fontSize: 13,
                        padding: "0 3px",
                      }}
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      title={t("sessions.projectMenu")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu({
                          project,
                          x: e.currentTarget.getBoundingClientRect().right,
                          y: e.currentTarget.getBoundingClientRect().bottom,
                        });
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-dim)",
                        fontSize: 12,
                        padding: "0 3px",
                      }}
                    >
                      ⋮
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div>
                      {visible.map((s) => renderItem(s))}
                      {total > visible.length && (
                        <button
                          type="button"
                          onClick={() => setShowAll((prev) => new Set(prev).add(project.id))}
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--accent)",
                            fontSize: 11,
                            padding: "2px 6px 2px 26px",
                          }}
                        >
                          {t("sessions.showAllSessions", { n: total })}
                        </button>
                      )}
                      {total === 0 && !projectHasPinnedSessions && (
                        <div style={{ padding: "4px 6px 6px 26px", fontSize: 11, color: "var(--text-dim)" }}>
                          {t("sessions.sessionsYetClickCreate")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          {sessionSpace === "mine" && !unreadOnly && projects.length === 0 && hostGroups.length === 0 && (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("sessions.projectsYetUseButtonAbove")}
            </div>
          )}

          {sessionSpace === "host" && !unreadOnly && hostGroups.length === 0 && (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("sessions.hostSessionsYetSessionsOpened")}
            </div>
          )}

          {/* 快速会话空间：按模板版本两级分组（模板名 (hash) → 会话），组织方式
          对齐"项目 → 会话"。模板已删除的组（快照仍在工作区）显示"模板已删除"
          徽标且不提供 ＋ 新建；旧会话永远留在自己的组里，不会因删模板而混堆。
          创建入口仍是侧栏顶部的 ⚡ 按钮，组头部的 ＋ 是就近快捷方式。 */}
          {sessionSpace === "quick" && (
            <>
              {quickGroups.map((group) => {
                const key = `quick:${group.key}`;
                const isCollapsed = collapsed.has(key);
                const expandedAll = showAll.has(key);
                const visible = isCollapsed ? [] : expandedAll ? group.sessions : group.sessions.slice(0, RECENT_COUNT);
                const focusInGroup = Boolean(
                  selectedSessionId && group.sessions.some((s) => s.id === selectedSessionId),
                );
                return (
                  <div key={key} style={{ marginBottom: 2 }}>
                    <div
                      onClick={() => toggleCollapsed(key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "5px 6px",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text)",
                        background: focusInGroup ? "var(--bg-selected)" : "var(--bg-panel)",
                      }}
                      onMouseEnter={(e) => {
                        if (!focusInGroup) e.currentTarget.style.background = "var(--bg-selected)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = focusInGroup ? "var(--bg-selected)" : "var(--bg-panel)";
                      }}
                    >
                      <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      <span
                        title={group.detached ? t("sessions.quickDetachedHint") : t("sessions.quickSessionsHint")}
                        style={{
                          flexShrink: 0,
                          padding: "0 5px",
                          borderRadius: 3,
                          fontSize: 9,
                          fontWeight: 700,
                          color: "#fbbf24",
                          background: "rgba(251,191,36,0.12)",
                        }}
                      >
                        ⚡
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={group.hash ? `${group.name} (${group.hash})` : group.name}
                      >
                        {group.hash
                          ? `${group.name} (${group.hash})`
                          : group.name || t("sessions.quickUnassignedGroup")}
                      </span>
                      {group.detached && (
                        <span
                          title={t("sessions.quickDetachedHint")}
                          style={{
                            flexShrink: 0,
                            padding: "0 5px",
                            borderRadius: 3,
                            fontSize: 9,
                            fontWeight: 700,
                            color: "var(--text-dim)",
                            background: "rgba(128,128,128,0.16)",
                          }}
                        >
                          {t("sessions.quickTemplateDeleted")}
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{group.sessions.length}</span>
                      {!group.detached && group.templateId && onNewSessionFromTemplate && (
                        <button
                          type="button"
                          title={t("sessions.newSession")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onNewSessionFromTemplate(group.templateId!, group.name);
                          }}
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-dim)",
                            fontSize: 13,
                            padding: "0 3px",
                          }}
                        >
                          ＋
                        </button>
                      )}
                    </div>
                    {visible.map((s) => renderItem(s))}
                    {!isCollapsed && !expandedAll && group.sessions.length > RECENT_COUNT && (
                      <button
                        type="button"
                        onClick={() => setShowAll((prev) => new Set(prev).add(key))}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--accent)",
                          fontSize: 11,
                          padding: "2px 6px 2px 26px",
                        }}
                      >
                        {t("sessions.showAllSessions", { n: group.sessions.length })}
                      </button>
                    )}
                  </div>
                );
              })}
              {quickGroups.length === 0 && !unreadOnly && (
                <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
                  {t("sessions.quickSessionsYetPickTemplate")}
                </div>
              )}
            </>
          )}

          {/* Host 空间动态分组（admin）。快速空间是纯 quick 列表——Host 目录组
          只属于 mine/host 视图，混进来会稀释快速会话（用户明确要求剔除）。 */}
          {sessionSpace !== "quick" &&
            orderedHostGroups
              .filter(([, list]) => !unreadOnly || list.length > 0)
              .map(([root, list]) => {
              const key = `host:${root}`;
              const isCollapsed = collapsed.has(key);
              // Mirrors the project branch: "show all" must widen `visible` — this
              // always sliced to RECENT_COUNT, so the button wrote showAll state
              // that nothing read and the click appeared dead.
              const expandedAll = showAll.has(key);
              const visible = isCollapsed ? [] : expandedAll ? list : list.slice(0, RECENT_COUNT);
              const record = hostDirByRoot.get(root);
              const displayName = record?.name?.trim() ? record.name.trim() : hostDirLabel(root);
              const hostPinned = pinnedProjectKeys.has(hostPinKey(root));
              const hostHasPinnedSessions = pinnedSessions.some(
                (s) => s.mode === "host" && (s.projectRoot ?? s.cwd) === root,
              );
              return (
                <div key={key} style={{ marginBottom: 2, order: groupRenderOrder.get(key) ?? 0 }}>
                  <div
                    onClick={() => toggleCollapsed(key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 6px",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      background: "transparent",
                    }}
                  >
                    <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
                    <span
                      style={{
                        flexShrink: 0,
                        padding: "0 5px",
                        borderRadius: 3,
                        fontSize: 9,
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        background: "rgba(128,128,128,0.14)",
                      }}
                    >
                      Host
                    </span>
                    {hostPinned && (
                      <Pin size={11} fill="currentColor" style={{ color: "#f59e0b", flexShrink: 0 }} aria-hidden="true" />
                    )}
                    {/* 显示末级文件夹名（完整路径进 tooltip）——全路径太冗余 */}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={root}
                    >
                      {displayName}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{list.length}</span>
                    {onNewSessionInDirectory && (
                      <button
                        type="button"
                        title={t("sessions.newSession")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSessionInDirectory(root);
                        }}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--text-dim)",
                          fontSize: 13,
                          padding: "0 3px",
                        }}
                      >
                        ＋
                      </button>
                    )}
                    <button
                      type="button"
                      title={t("sessions.directoryMenu")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu({
                          directory: root,
                          x: e.currentTarget.getBoundingClientRect().right,
                          y: e.currentTarget.getBoundingClientRect().bottom,
                        });
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-dim)",
                        fontSize: 12,
                        padding: "0 3px",
                      }}
                    >
                      ⋮
                    </button>
                  </div>
                  {visible.map((s) => renderItem(s))}
                  {!isCollapsed && list.length === 0 && !hostHasPinnedSessions && (
                    <div style={{ padding: "4px 6px 6px 26px", fontSize: 11, color: "var(--text-dim)" }}>
                      {t("sessions.hostDirEmptyHint")}
                    </div>
                  )}
                  {!isCollapsed && !expandedAll && list.length > RECENT_COUNT && (
                    <button
                      type="button"
                      onClick={() => setShowAll((prev) => new Set(prev).add(key))}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--accent)",
                        fontSize: 11,
                        padding: "2px 6px 2px 26px",
                      }}
                    >
                      {t("sessions.showAllSessions", { n: list.length })}
                    </button>
                  )}
                </div>
              );
            })}

          {/* 未绑定项目的非宿主模式会话（如 API 直建的 pre-project 沙箱会话）：
          按模式成组、带正确徽标——之前被 Host 目录组吞掉，会话徽标与项目
          徽标各说各话。 */}
          {sessionSpace !== "quick" &&
            unboundModeGroups.map(([mode, list]) => {
              const key = `unbound:${mode}`;
              const isCollapsed = collapsed.has(key);
              const badge =
                mode === "sandbox"
                  ? { label: t("sessions.sandbox"), color: "#38bdf8", bg: "rgba(56,189,248,0.12)" }
                  : mode === "ssh"
                    ? { label: t("SSH"), color: "#34d399", bg: "rgba(52,211,153,0.14)" }
                    : { label: t("sessions.local"), color: "#a78bfa", bg: "rgba(167,139,250,0.12)" };
              const visible = isCollapsed ? [] : list;
              return (
                <div key={key} style={{ marginBottom: 2, order: groupRenderOrder.get(key) ?? 0 }}>
                  <div
                    onClick={() => toggleCollapsed(key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 6px",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      background: "transparent",
                    }}
                  >
                    <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
                    <span
                      style={{
                        flexShrink: 0,
                        padding: "0 5px",
                        borderRadius: 3,
                        fontSize: 9,
                        fontWeight: 700,
                        color: badge.color,
                        background: badge.bg,
                      }}
                    >
                      {badge.label}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("sessions.unboundSuffix")}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{list.length}</span>
                  </div>
                  {visible.map((s) => renderItem(s))}
                </div>
              );
            })}
        </>
      )}

      {/* 目录菜单（Host 空间的动态目录组） */}
      {menu?.directory && onNewSessionInDirectory && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: menu.y,
            left: Math.max(8, menu.x - 160),
            zIndex: 1200,
            display: "flex",
            flexDirection: "column",
            minWidth: 160,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            overflow: "hidden",
            fontSize: 12,
          }}
        >
          <MenuItem
            label={
              pinnedProjectKeys.has(hostPinKey(menu.directory!))
                ? t("sessions.unpinProject")
                : t("sessions.pinProject")
            }
            onClick={() => {
              const key = hostPinKey(menu.directory!);
              toggleProjectPin(key, !pinnedProjectKeys.has(key));
              setMenu(null);
            }}
          />
          <MenuItem
            label={t("sessions.newSession")}
            onClick={() => {
              onNewSessionInDirectory(menu.directory!);
              setMenu(null);
            }}
          />
          <MenuItem
            label={t("sessions.importProjectConfig")}
            onClick={() => {
              setHostImportDir(menu.directory!);
              setMenu(null);
            }}
          />
          <MenuItem
            label={t("bundles.applyMenu")}
            onClick={() => {
              setApplyHostDir(menu.directory!);
              setMenu(null);
            }}
          />
          <MenuItem
            label={t("sessions.exportConfigBundle")}
            onClick={() => {
              void exportHostConfig(menu.directory!);
              setMenu(null);
            }}
          />
          <MenuItem
            label={t("sessions.copyPath")}
            onClick={() => {
              void navigator.clipboard?.writeText(menu.directory!).catch(() => {});
              setMenu(null);
            }}
          />
          <MenuItem
            label={t("sessions.browseFilePanel")}
            onClick={() => {
              // 与项目会话同一套文件面板：把该目录设为当前工作目录并建一个会话。
              onNewSessionInDirectory(menu.directory!);
              setMenu(null);
            }}
          />
          {/* 注册表占位管理：重命名 / 从列表移除。移除仅删占位记录，
              不碰真实目录；有会话时隐藏移除项（避免"点了没变化"）。 */}
          {(() => {
            const record = hostDirByRoot.get(menu.directory!);
            if (!record) return null;
            const count = hostGroups.find(([root]) => root === menu.directory)?.[1].length ?? 0;
            return (
              <>
                <div style={{ borderTop: "1px solid var(--border)" }} />
                <MenuItem
                  label={t("sessions.renameHostDir")}
                  onClick={() => {
                    const name = window.prompt(t("sessions.newProjectName"), record.name ?? "");
                    setMenu(null);
                    if (name === null) return;
                    void fetch("/api/host/dirs", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: record.id, name }),
                    })
                      .then(() => loadHostDirs())
                      .catch(() => {});
                  }}
                />
                {count === 0 && (
                  <MenuItem
                    label={t("sessions.removeHostDir")}
                    danger
                    onClick={() => {
                      setMenu(null);
                      void fetch(`/api/host/dirs?id=${encodeURIComponent(record.id)}`, { method: "DELETE" })
                        .then(() => loadHostDirs())
                        .catch(() => {});
                    }}
                  />
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* 项目菜单 */}
      {(() => {
        const menuProject = menu?.project;
        if (!menuProject) return null;
        const menuProjectKey = projectPinKey(menuProject.id);
        const menuProjectPinned = pinnedProjectKeys.has(menuProjectKey);
        return (
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: menu.y,
              left: Math.max(8, menu.x - 160),
              zIndex: 1200,
              display: "flex",
              flexDirection: "column",
              minWidth: 160,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
              overflow: "hidden",
              fontSize: 12,
            }}
          >
            <MenuItem
              label={menuProjectPinned ? t("sessions.unpinProject") : t("sessions.pinProject")}
              onClick={() => {
                toggleProjectPin(menuProjectKey, !menuProjectPinned);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("sessions.newSession")}
              onClick={() => {
                onNewSessionInProject(menuProject);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("common.rename")}
              onClick={() => {
                const name = window.prompt(t("sessions.newProjectName"), menuProject.name);
                if (name?.trim()) {
                  void fetch(`/api/projects/${encodeURIComponent(menuProject.id)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: name.trim() }),
                  }).then(() => loadProjects());
                }
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("sessions.duplicateNewProject")}
              onClick={() => {
                void duplicate(menuProject);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("sessions.settingsModelCredentials")}
              onClick={() => {
                setSettingsId(menuProject.id);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("sessions.importProjectConfig")}
              onClick={() => {
                setImportId(menuProject.id);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("sessions.workspaceSyncConfig")}
              onClick={() => {
                void syncWorkspaceConfig(menuProject);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("bundles.applyMenu")}
              onClick={() => {
                setApplyBundleId(menuProject.id);
                setMenu(null);
              }}
            />
            <MenuItem
              label={t("sessions.exportConfigBundle")}
              onClick={() => {
                void exportConfig(menuProject);
                setMenu(null);
              }}
            />
            {menuProject.mode === "sandbox" &&
              (() => {
                // 绑定信息：项目 → 容器 → 镜像 三位一体（debug 友好）。
                const boundInfo =
                  menuProject.containerId != null
                    ? containers.find((c) => c.id === menuProject.containerId)
                    : undefined;
                return (
                  <div
                    style={{
                      borderTop: "1px solid var(--border)",
                      padding: "6px 10px",
                      color: "var(--text-dim)",
                      fontSize: 10.5,
                      lineHeight: 1.6,
                    }}
                  >
                    {t("sessions.container", {
                      info: boundInfo
                        ? `#${boundInfo.id} · ${boundInfo.status === "running" ? t("projects.running") : boundInfo.status}`
                        : "未绑定",
                    })}
                    {boundInfo?.imageName ? ` · ${boundInfo.imageName}` : ""}
                    {t("sessions.saves2MostRecent2", { n: menuProject.snapshotSlots?.length ?? 0 })}
                  </div>
                );
              })()}
            {menuProject.mode === "sandbox" && (
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: "4px 10px",
                  color: "var(--text-dim)",
                  fontSize: 10,
                }}
              >
                存档（含环境与文件）
              </div>
            )}
            {menuProject.mode === "sandbox" && (
              <MenuItem
                label={t("sessions.saveStateSnapshot")}
                onClick={() => {
                  void projectSnapshot(menuProject, "save");
                  setMenu(null);
                }}
              />
            )}
            {menuProject.mode === "sandbox" &&
              (menuProject.snapshotSlots ?? []).map((slot) => (
                <MenuItem
                  key={slot.id}
                  label={t("sessions.restoreSave", { time: new Date(slot.createdAt).toLocaleString() })}
                  onClick={() => {
                    void projectSnapshot(menuProject, "restore", slot.id);
                    setMenu(null);
                  }}
                />
              ))}
            {menuProject.mode === "sandbox" && (
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: "4px 10px",
                  color: "var(--text-dim)",
                  fontSize: 10,
                }}
              >
                文件留存（仅文件）
              </div>
            )}
            {menuProject.mode === "sandbox" && (
              <MenuItem
                label={t("sessions.exportMyWorkspaceTarGz")}
                onClick={() => {
                  void exportWorkspace(menuProject);
                  setMenu(null);
                }}
              />
            )}
            {menuProject.mode === "sandbox" && (
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: "4px 10px",
                  color: "var(--text-dim)",
                  fontSize: 10,
                }}
              >
                沙箱容器
              </div>
            )}
            {menuProject.mode === "sandbox" &&
              containers.map((c) => (
                <MenuItem
                  key={c.id}
                  label={`${menuProject.containerId === c.id ? "● " : "○ "}${c.name} (#${c.id})`}
                  onClick={() => void setContainer(menuProject, c.id)}
                />
              ))}
            {menuProject.mode === "sandbox" && (
              <MenuItem
                label={t("sessions.followPlatformDefaultContainer")}
                onClick={() => void setContainer(menuProject, null)}
              />
            )}
            {menuProject.mode === "sandbox" && onManageSandbox && (
              <MenuItem
                label={t("sessions.manageContainers")}
                onClick={() => {
                  onManageSandbox(menuProject);
                  setMenu(null);
                }}
              />
            )}
            <div style={{ borderTop: "1px solid var(--border)" }} />
            <div
              style={{
                padding: "4px 10px",
                color: "var(--text-dim)",
                fontSize: 10,
              }}
            >
              {t("sessions.tempFiles")}
            </div>
            <MenuItem
              label={t("sessions.cleanAttachments")}
              onClick={() => {
                void cleanAttachments(menuProject);
                setMenu(null);
              }}
            />
            <div style={{ borderTop: "1px solid var(--border)" }} />
            <MenuItem
              label={t("sessions.deleteProject")}
              danger
              onClick={() => {
                void remove(menuProject);
                setMenu(null);
              }}
            />
          </div>
        );
      })()}

      {settingsId && (
        <ProjectSettingsDialog
          projectId={settingsId}
          onClose={() => setSettingsId(null)}
          onChanged={() => {
            loadProjects();
            refreshSessions();
          }}
        />
      )}

      {hostImportDir && (
        <ProjectImportDialog
          hostDir={hostImportDir}
          projectName={hostImportDir.split("/").filter(Boolean).pop() ?? hostImportDir}
          onClose={() => setHostImportDir(null)}
          onImported={() => refreshSessions()}
        />
      )}
      {importId && (
        <ProjectImportDialog
          projectId={importId}
          projectName={projects.find((p) => p.id === importId)?.name ?? importId}
          onClose={() => setImportId(null)}
          onImported={() => {
            loadProjects();
            refreshSessions();
          }}
        />
      )}
      {applyBundleId && (
        <ApplyBundleDialog
          projectId={applyBundleId}
          projectName={projects.find((p) => p.id === applyBundleId)?.name ?? applyBundleId}
          onClose={() => setApplyBundleId(null)}
          onApplied={() => {
            loadProjects();
            refreshSessions();
          }}
        />
      )}
      {applyHostDir && (
        <ApplyBundleDialog
          hostDir={applyHostDir}
          projectName={applyHostDir.split("/").filter(Boolean).pop() ?? applyHostDir}
          onClose={() => setApplyHostDir(null)}
          onApplied={() => refreshSessions()}
        />
      )}
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        padding: "7px 12px",
        fontSize: 12,
        color: danger ? "#f87171" : "var(--text)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {label}
    </button>
  );
}

/**
 * 项目内会话行 — 与 SessionSidebar 的 SessionItem 相同的交互模式：
 * hover 显示 重命名/删除 按钮；重命名原位输入框（Enter 提交 / Esc 取消）；
 * 删除先在行内显示 红色确认/取消（Shift+点击跳过确认）。
 */
function ProjectSessionRow({
  session,
  selected,
  running,
  unread,
  pinned,
  canPin,
  nested = false,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
}: {
  session: SessionInfo;
  selected: boolean;
  running: boolean;
  unread: boolean;
  pinned: boolean;
  canPin: boolean;
  /** 子智能体行：更深缩进 + ⌘ 标记（非运行态）。 */
  nested?: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const title = session.name || session.firstMessage.slice(0, 40) || session.id.slice(0, 8);
  const busyRow = renaming || confirmDelete;

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const commitRename = () => {
    setRenaming(false);
    const name = renameValue.trim();
    if (name && name !== (session.name ?? "")) onRename(name);
  };

  if (confirmDelete) {
    return (
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: 34,
          padding: "0 6px 0 26px",
          borderRadius: 5,
          cursor: "default",
          background: "rgba(239,68,68,0.06)",
          borderLeft: "2px solid #ef4444",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t("common.delete")}{" "}
          <span style={{ fontWeight: 600 }}>
            “{title.slice(0, 20)}
            {title.length > 20 ? "…" : ""}”
          </span>
          ？
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => {
              setConfirmDelete(false);
              onDelete();
            }}
            style={{
              height: 22,
              padding: "0 9px",
              borderRadius: 5,
              border: "none",
              background: "#ef4444",
              color: "#fff",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t("common.delete")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            style={{
              height: 22,
              padding: "0 9px",
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 11,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={busyRow ? undefined : onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 34,
        padding: "0 6px 0 26px",
        borderRadius: 5,
        cursor: busyRow ? "default" : "pointer",
        background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.1s",
        ...(nested ? { paddingLeft: 46 } : {}),
      }}
    >
      {renaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            minWidth: 0,
            height: 24,
            fontSize: 12,
            padding: "2px 7px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
          }}
        />
      ) : (
        <>
          {nested && !running && (
            <span
              title={t("sessions.subagentSession")}
              style={{ fontSize: 10, lineHeight: 1, color: "var(--text-dim)", flexShrink: 0 }}
            >
              ⌘
            </span>
          )}
          {running && <span style={{ width: 6, height: 6, borderRadius: 999, background: "#4ade80", flexShrink: 0 }} />}
          {pinned && canPin && (
            <button
              type="button"
              title={t("sessions.unpin")}
              aria-label={t("sessions.unpin")}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "#f59e0b",
                flexShrink: 0,
              }}
            >
              <Pin size={12} fill="currentColor" />
            </button>
          )}
          {unread && (
            <span
              title={t("sessions.unread")}
              aria-label={t("sessions.unread")}
              style={{ width: 6, height: 6, borderRadius: 999, background: "#f59e0b", flexShrink: 0 }}
            />
          )}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: unread ? 600 : 400,
              color: "var(--text)",
            }}
            title={title}
          >
            {title}
          </span>
          {session.mode && session.mode !== "host" && (
            <span
              style={{
                fontSize: 9,
                color: session.mode === "sandbox" ? "#38bdf8" : session.mode === "quick" ? "#fbbf24" : "#a78bfa",
                flexShrink: 0,
              }}
            >
              {session.mode === "sandbox"
                ? t("app.sandbox")
                : session.mode === "quick"
                  ? t("sessions.quick2")
                  : t("app.localMachine")}
            </span>
          )}
          <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
            {formatRelativeTime(new Date(session.modified).getTime())}
          </span>
          {canPin && !pinned && hovered && (
            <button
              type="button"
              title={t("sessions.pin")}
              aria-label={t("sessions.pin")}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "0 2px",
                color: "var(--text-dim)",
                flexShrink: 0,
              }}
            >
              <Pin size={12} />
            </button>
          )}
          {hovered && (
            <>
              <button
                type="button"
                title={t("common.rename")}
                onClick={startRename}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  borderRadius: 5,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
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
                >
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                type="button"
                title={t("sessions.openInNewTab")}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(
                    `/?session=${encodeURIComponent(session.id)}`,
                    "_blank",
                    "noopener,noreferrer",
                  );
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  borderRadius: 5,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
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
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
              <button
                type="button"
                title={t("sessions.deleteSession")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) onDelete();
                  else setConfirmDelete(true);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  background: "transparent",
                  border: "none",
                  borderRadius: 5,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#ef4444";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
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
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
