"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import type { ProjectRecord } from "@/lib/projects";
import { formatRelativeTime } from "@/lib/subagent-shared";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { ProjectImportDialog } from "./ProjectImportDialog";

interface Props {
  sessions: SessionInfo[];
  runningSessionIds: Set<string>;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onNewSessionInProject: (project: ProjectRecord) => void;
  /** Host 空间：在指定服务器目录创建/打开会话。 */
  onNewSessionInDirectory?: (directory: string) => void;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  refreshSessions: () => void;
  isAdmin: boolean;
  sessionSpace: "mine" | "host";
  onSessionSpaceChange?: (space: "mine" | "host") => void;
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
  selectedSessionId,
  onSelectSession,
  onNewSessionInProject,
  onNewSessionInDirectory,  onDeleteSession,
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
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [hostImportDir, setHostImportDir] = useState<string | null>(null);
  const [containers, setContainers] = useState<Array<{ id: number; name: string; status: string; imageName: string }>>([]);
  const [newDialog, setNewDialog] = useState<"sandbox" | "local-machine" | null>(null);
  const [myWorkspaceId, setMyWorkspaceId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const loadProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d: { projects?: ProjectRecord[] }) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects, projectsRefreshKey]);

  // Container list: status dots on project nodes + the container picker.
  const loadContainers = useCallback(() => {
    fetch("/api/sandbox/containers")
      .then((r) => (r.ok ? r.json() : { containers: [] }))
      .then((d: { containers?: Array<{ id: number; name: string; status: string; imageName: string }> }) => setContainers(d.containers ?? []))
      .catch(() => setContainers([]));
  }, []);
  useEffect(() => { loadContainers(); }, [loadContainers, projectsRefreshKey]);
  useEffect(() => { if (menu?.project?.mode === "sandbox") loadContainers(); }, [menu, loadContainers]);

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
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const pin = async (project: ProjectRecord, sessionId: string, pinned: boolean) => {
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pinned ? { unpinSessionId: sessionId } : { pinSessionId: sessionId }),
    }).catch(() => {});
    loadProjects();
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
      window.alert(t("导出失败，请重试"));
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
      window.alert(t("导出失败，请重试"));
    }
  };
  const remove = async (project: ProjectRecord) => {
    if (!window.confirm(t("删除项目「{name}」及其配置目录？（会话记录保留）", { name: project.name }))) return;
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(() => {});
    loadProjects();
    refreshSessions();
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
  const projectSnapshot = async (project: ProjectRecord, action: "save" | "restore" | "delete", snapshotId?: number) => {
    if (menuBusy) return;
    if (action === "restore" && !window.confirm(t("恢复存档？容器 /workspace 将回到存档时间点，之后的改动会丢失。"))) return;
    setMenuBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(snapshotId != null ? { snapshotId } : {}) }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        window.alert(d?.error ?? t("操作失败：HTTP {code}", { code: res.status }));
        return;
      }
      if (action === "save") window.alert(t("已保存存档（保留最近 2 个）。"));
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
    if (project.containerId == null) { window.alert(t("项目没有绑定容器")); return; }
    if (myWorkspaceId == null) { window.alert(t("工作区不可用")); return; }
    setMenuBusy(true);
    try {
      const res = await fetch(`/api/sandbox/containers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export-workspace", containerId: project.containerId, workspaceId: myWorkspaceId }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; fileName?: string };
      if (!res.ok) {
        window.alert(d?.error ?? t("导出失败：HTTP {code}", { code: res.status }));
        return;
      }
      window.alert(t("已导出到我的工作区：{file}（仅文件；完整环境请用存档）", { file: d.fileName ?? "*.tar.gz" }));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setMenuBusy(false);
    }
  };

  // Group sessions by project; ungrouped (host-mode/CLI) by projectRoot.
  const byProject = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    const ungrouped: SessionInfo[] = [];
    for (const s of sessions) {
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
  }, [sessions]);

  // 管理员通过"打开服务器目录"（host 模式）建的会话没有 projectId，按目录
  // 动态分组显示——不区分 mine/host 空间（UI 没有空间切换入口，之前 gate
  // 在 sessionSpace==="host" 上导致这些会话永远不显示）。
  const hostGroups = useMemo(() => {
    if (!isAdmin) return [];
    const groups = new Map<string, SessionInfo[]>();
    for (const s of byProject.ungrouped) {
      const key = s.projectRoot ?? s.cwd;
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => {
      const latest = (entry: [string, SessionInfo[]]) => entry[1][0]?.modified ?? "";
      return latest(b).localeCompare(latest(a));
    });
  }, [byProject.ungrouped, isAdmin]);

  const renderItem = (s: SessionInfo, project: ProjectRecord | null) => {
    const selected = s.id === selectedSessionId;
    const running = runningSessionIds.has(s.id);
    const pinned = project?.pinnedSessions.includes(s.id) ?? false;
    return (
      <ProjectSessionRow
        key={s.id}
        session={s}
        selected={selected}
        running={running}
        pinned={pinned}
        canPin={Boolean(project)}
        onSelect={() => onSelectSession(s)}
        onRename={(name) => void onRenameSession(s.id, name)}
        onDelete={() => void onDeleteSession(s.id)}
        onTogglePin={() => { if (project) void pin(project, s.id, pinned); }}
      />
    );
  };

  const projectSessions = (project: ProjectRecord): { visible: SessionInfo[]; total: number } => {
    const all = byProject.map.get(project.id) ?? [];
    const pinned = project.pinnedSessions
      .map((id) => all.find((s) => s.id === id))
      .filter((s): s is SessionInfo => Boolean(s));
    const rest = all.filter((s) => !project.pinnedSessions.includes(s.id));
    const expandedAll = showAll.has(project.id);
    const recent = expandedAll ? rest : rest.slice(0, RECENT_COUNT - Math.min(pinned.length, RECENT_COUNT));
    return { visible: [...pinned, ...recent], total: all.length };
  };

  // 全局会话搜索：按名称/首条消息/id 过滤全部会话，平铺显示（含所属项目标记）。
  const searching = query.trim().length > 0;
  const allSessionsSorted = useMemo(
    () => [...sessions].sort((a, b) => b.modified.localeCompare(a.modified)),
    [sessions],
  );
  const searchResults = useMemo(() => {
    if (!searching) return [] as SessionInfo[];
    const q = query.trim().toLowerCase();
    return allSessionsSorted
      .filter((s) =>
        s.name?.toLowerCase().includes(q)
        || s.firstMessage.toLowerCase().includes(q)
        || s.id.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [searching, query, allSessionsSorted]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 4px" }}>
      {/* Admin 空间切换：我的项目会话 ↔ Host 空间（CLI / 服务器目录会话）。 */}
      {isAdmin && onSessionSpaceChange && !searching && (
        <div style={{ display: "flex", gap: 0, padding: "0 4px 8px", borderRadius: 6, border: "1px solid var(--border)", overflow: "hidden", fontSize: 11 }}>
          {(["mine", "host"] as const).map((space) => {
            const active = sessionSpace === space;
            return (
              <button
                key={space}
                type="button"
                onClick={() => onSessionSpaceChange(space)}
                title={space === "host" ? t("Host 会话：CLI 与服务器目录产生的会话（全局 sessions 目录）") : t("我的项目会话")}
                style={{
                  flex: 1, padding: "4px 0", border: "none", cursor: "pointer",
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-dim)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {space === "mine" ? t("我的会话") : "Host (CLI)"}
              </button>
            );
          })}
        </div>
      )}

      {/* 全局会话搜索 */}
      <div style={{ padding: "0 4px 8px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          placeholder={t("搜索会话…")}
          spellCheck={false}
          style={{
            width: "100%", boxSizing: "border-box", height: 26, padding: "0 8px",
            background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
            borderRadius: 5, fontFamily: "var(--font-mono)", fontSize: 11, outline: "none",
          }}
        />
      </div>

      {searching && (
        <div>
          {searchResults.length === 0 ? (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>{t("没有匹配的会话")}</div>
          ) : searchResults.map((s) => {
            const owner = projects.find((p) => p.id === s.projectId) ?? null;
            return (
              <div key={`search:${s.id}`} style={{ marginBottom: 2 }}>
                <div style={{ padding: "2px 8px", fontSize: 10, color: "var(--text-dim)" }}>
                  {owner ? t("项目：{name}", { name: owner.name }) : s.projectRoot ?? t("未分组")}
                </div>
                {renderItem(s, owner)}
              </div>
            );
          })}
        </div>
      )}

      {!searching && (<>
      {/* 项目列表在两个空间都显示：host 空间下项目会话不在当前列表里，
          项目显示为空态（暂无会话）——这正是快速建会话的入口，不能隐藏。 */}
      {projects.map((project) => {
        const { visible, total } = projectSessions(project);
        const isCollapsed = collapsed.has(project.id);
        // 焦点会话所属项目高亮 + 左侧模式色条，一眼定位当前所在项目。
        const projectHoldsFocus = Boolean(selectedSessionId && byProject.map.get(project.id)?.some((s) => s.id === selectedSessionId));
        const modeColor = project.mode === "sandbox" ? "#38bdf8" : "#a78bfa";
        // 容器状态点（沙箱项目绑定容器的前台可见性）。
        const bound = project.containerId != null ? containers.find((c) => c.id === project.containerId) : undefined;
        const containerState = bound?.status === "running" ? { color: "#22c55e", label: t("运行中") }
          : bound?.status === "stopped" ? { color: "#9ca3af", label: t("已停止") }
          : bound ? { color: "#f59e0b", label: bound.status }
          : { color: "#ef4444", label: t("无容器") };
        return (
          <div key={project.id} style={{ marginBottom: 2 }}>
            <div
              onClick={() => toggleCollapsed(project.id)}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "5px 6px",
                borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
                color: "var(--text)",
                background: projectHoldsFocus ? "var(--bg-selected)" : "var(--bg-panel)",
                boxShadow: projectHoldsFocus ? `inset 2px 0 0 ${modeColor}` : "none",
              }}
              onMouseEnter={(e) => { if (!projectHoldsFocus) e.currentTarget.style.background = "var(--bg-selected)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = projectHoldsFocus ? "var(--bg-selected)" : "var(--bg-panel)"; }}
            >
              <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
              {project.mode === "sandbox" ? (
                <span
                  title={t("容器：{info}", { info: bound ? `#${bound.id} ${bound.name} · ${containerState.label}${bound.imageName ? ` · ${bound.imageName}` : ""}` : containerState.label })}
                  style={{ width: 8, height: 8, borderRadius: "50%", background: containerState.color, flexShrink: 0, boxShadow: containerState.label === "运行中" ? `0 0 5px ${containerState.color}` : "none" }}
                />
              ) : (
                <span style={{ width: 8, height: 8, flexShrink: 0 }} />
              )}
              <span style={{
                flexShrink: 0, padding: "0 5px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                color: modeColor, background: project.mode === "sandbox" ? "rgba(56,189,248,0.12)" : "rgba(167,139,250,0.12)",
              }}>
                {project.mode === "sandbox" ? t("沙盒") : t("本地")}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>
              {project.mode === "sandbox" && (
                <span title={t("项目会话在容器 /workspace 内执行")} style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-dim)" }}>/workspace</span>
              )}
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{total}</span>
              <button
                type="button"
                title={t("新建会话")}
                onClick={(e) => { e.stopPropagation(); onNewSessionInProject(project); }}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 13, padding: "0 3px" }}
              >＋</button>
              <button
                type="button"
                title={t("项目菜单")}
                onClick={(e) => { e.stopPropagation(); setMenu({ project, x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom }); }}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 12, padding: "0 3px" }}
              >⋮</button>
            </div>
            {!isCollapsed && (
              <div>
                {visible.map((s) => renderItem(s, project))}
                {total > visible.length && (
                  <button
                    type="button"
                    onClick={() => setShowAll((prev) => new Set(prev).add(project.id))}
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 11, padding: "2px 6px 2px 26px" }}
                  >
                    {t("显示全部 {n} 个会话", { n: total })}
                  </button>
                )}
                {total === 0 && (
                  <div style={{ padding: "4px 6px 6px 26px", fontSize: 11, color: "var(--text-dim)" }}>{t("暂无会话，点 ＋ 新建")}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {sessionSpace === "mine" && projects.length === 0 && hostGroups.length === 0 && (
        <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>{t("还没有项目——点上方按钮创建第一个。")}</div>
      )}

      {sessionSpace === "host" && hostGroups.length === 0 && (
        <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>{t("Host 空间暂无会话——在服务器上用 pi CLI 打开的会话会出现在这里")}</div>
      )}

      {/* Host 空间动态分组（admin） */}
      {hostGroups.map(([root, list]) => {
        const key = `host:${root}`;
        const isCollapsed = collapsed.has(key);
        const visible = isCollapsed ? [] : list.slice(0, RECENT_COUNT);
        return (
          <div key={key} style={{ marginBottom: 2 }}>
            <div
              onClick={() => toggleCollapsed(key)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--text-muted)", background: "transparent" }}
            >
              <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
              <span style={{
                flexShrink: 0, padding: "0 5px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                color: "var(--text-muted)", background: "rgba(128,128,128,0.14)",
              }}>Host</span>
              {/* 显示末级文件夹名（完整路径进 tooltip）——全路径太冗余 */}
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={root}>
                {root.split("/").filter(Boolean).pop() ?? root}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{list.length}</span>
              {onNewSessionInDirectory && (
                <button
                  type="button"
                  title={t("新建会话")}
                  onClick={(e) => { e.stopPropagation(); onNewSessionInDirectory(root); }}
                  style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 13, padding: "0 3px" }}
                >＋</button>
              )}
              <button
                type="button"
                title={t("目录菜单")}
                onClick={(e) => { e.stopPropagation(); setMenu({ directory: root, x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom }); }}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 12, padding: "0 3px" }}
              >⋮</button>
            </div>
            {visible.map((s) => renderItem(s, null))}
            {!isCollapsed && list.length > RECENT_COUNT && (
              <button type="button" onClick={() => setShowAll((prev) => new Set(prev).add(key))} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 11, padding: "2px 6px 2px 26px" }}>
                {t("显示全部 {n} 个会话", { n: list.length })}
              </button>
            )}
          </div>
        );
      })}
      </>)}

      {/* 目录菜单（Host 空间的动态目录组） */}
      {menu?.directory && onNewSessionInDirectory && (
        <div
          ref={menuRef}
          style={{
            position: "fixed", top: menu.y, left: Math.max(8, menu.x - 160), zIndex: 1200,
            display: "flex", flexDirection: "column", minWidth: 160,
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)", overflow: "hidden", fontSize: 12,
          }}
        >
          <MenuItem label={t("新建会话")} onClick={() => { onNewSessionInDirectory(menu.directory!); setMenu(null); }} />
          <MenuItem label={t("导入项目配置…")} onClick={() => { setHostImportDir(menu.directory!); setMenu(null); }} />
          <MenuItem label={t("导出配置包…")} onClick={() => { void exportHostConfig(menu.directory!); setMenu(null); }} />
          <MenuItem label={t("复制路径")} onClick={() => {
            void navigator.clipboard?.writeText(menu.directory!).catch(() => {});
            setMenu(null);
          }} />
          <MenuItem label={t("在文件管理器中浏览")} onClick={() => {
            // 与项目会话同一套文件面板：把该目录设为当前工作目录并建一个会话。
            onNewSessionInDirectory(menu.directory!);
            setMenu(null);
          }} />
        </div>
      )}

      {/* 项目菜单 */}
      {(() => {
      const menuProject = menu?.project;
      if (!menuProject) return null;
      return (
        <div
          ref={menuRef}
          style={{
            position: "fixed", top: menu.y, left: Math.max(8, menu.x - 160), zIndex: 1200,
            display: "flex", flexDirection: "column", minWidth: 160,
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)", overflow: "hidden", fontSize: 12,
          }}
        >
          <MenuItem label={t("新建会话")} onClick={() => { onNewSessionInProject(menuProject); setMenu(null); }} />
          <MenuItem label={t("重命名")} onClick={() => {
            const name = window.prompt(t("项目新名称："), menuProject.name);
            if (name?.trim()) {
              void fetch(`/api/projects/${encodeURIComponent(menuProject.id)}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
              }).then(() => loadProjects());
            }
            setMenu(null);
          }} />
          <MenuItem label={t("复制为新项目")} onClick={() => { void duplicate(menuProject); setMenu(null); }} />
          <MenuItem label={t("设置（模型凭证等）")} onClick={() => { setSettingsId(menuProject.id); setMenu(null); }} />
          <MenuItem label={t("导入项目配置…")} onClick={() => { setImportId(menuProject.id); setMenu(null); }} />
          <MenuItem label={t("导出配置包…")} onClick={() => { void exportConfig(menuProject); setMenu(null); }} />
          {menuProject.mode === "sandbox" && (() => {
            // 绑定信息：项目 → 容器 → 镜像 三位一体（debug 友好）。
            const boundInfo = menuProject.containerId != null
              ? containers.find((c) => c.id === menuProject.containerId)
              : undefined;
            return (
              <div style={{ borderTop: "1px solid var(--border)", padding: "6px 10px", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.6 }}>
                {t("容器：{info}", { info: boundInfo ? `#${boundInfo.id} · ${boundInfo.status === "running" ? t("运行中") : boundInfo.status}` : "未绑定" })}
                {boundInfo?.imageName ? ` · ${boundInfo.imageName}` : ""}
                {t("存档 {n}/2（游戏存档制，保留最近 2 个）", { n: menuProject.snapshotSlots?.length ?? 0 })}
              </div>
            );
          })()}
          {menuProject.mode === "sandbox" && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "4px 10px", color: "var(--text-dim)", fontSize: 10 }}>存档（含环境与文件）</div>
          )}
          {menuProject.mode === "sandbox" && (
            <MenuItem label={t("保存存档（快照当前容器）")} onClick={() => { void projectSnapshot(menuProject, "save"); setMenu(null); }} />
          )}
          {menuProject.mode === "sandbox" && (menuProject.snapshotSlots ?? []).map((slot) => (
            <MenuItem
              key={slot.id}
              label={t("↩ 恢复存档 · {time}", { time: new Date(slot.createdAt).toLocaleString() })}
              onClick={() => { void projectSnapshot(menuProject, "restore", slot.id); setMenu(null); }}
            />
          ))}
          {menuProject.mode === "sandbox" && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "4px 10px", color: "var(--text-dim)", fontSize: 10 }}>文件留存（仅文件）</div>
          )}
          {menuProject.mode === "sandbox" && (
            <MenuItem label={t("导出到我的工作区（tar.gz）")} onClick={() => { void exportWorkspace(menuProject); setMenu(null); }} />
          )}
          {menuProject.mode === "sandbox" && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "4px 10px", color: "var(--text-dim)", fontSize: 10 }}>沙箱容器</div>
          )}
          {menuProject.mode === "sandbox" && containers.map((c) => (
            <MenuItem
              key={c.id}
              label={`${menuProject.containerId === c.id ? "● " : "○ "}${c.name} (#${c.id})`}
              onClick={() => void setContainer(menuProject, c.id)}
            />
          ))}
          {menuProject.mode === "sandbox" && (
            <MenuItem label={t("跟随平台默认容器")} onClick={() => void setContainer(menuProject, null)} />
          )}
          {menuProject.mode === "sandbox" && onManageSandbox && (
            <MenuItem label={t("管理沙箱容器（新建/启停/删除）…")} onClick={() => { onManageSandbox(menuProject); setMenu(null); }} />
          )}
          <div style={{ borderTop: "1px solid var(--border)" }} />
          <MenuItem label={t("删除项目")} danger onClick={() => { void remove(menuProject); setMenu(null); }} />
        </div>
      );
      })()}

      {settingsId && (
        <ProjectSettingsDialog
          projectId={settingsId}
          onClose={() => setSettingsId(null)}
          onChanged={() => { loadProjects(); refreshSessions(); }}
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
          onImported={() => { loadProjects(); refreshSessions(); }}
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
        background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
        padding: "7px 12px", fontSize: 12,
        color: danger ? "#f87171" : "var(--text)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
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
  session, selected, running, pinned, canPin, onSelect, onRename, onDelete, onTogglePin,
}: {
  session: SessionInfo;
  selected: boolean;
  running: boolean;
  pinned: boolean;
  canPin: boolean;
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
          display: "flex", alignItems: "center", gap: 7,
          height: 34, padding: "0 6px 0 26px", borderRadius: 5, cursor: "default",
          background: "rgba(239,68,68,0.06)", borderLeft: "2px solid #ef4444",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("删除")} <span style={{ fontWeight: 600 }}>“{title.slice(0, 20)}{title.length > 20 ? "…" : ""}”</span>？
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => { setConfirmDelete(false); onDelete(); }}
            style={{
              height: 22, padding: "0 9px", borderRadius: 5, border: "none",
              background: "#ef4444", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {t("删除")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            style={{
              height: 22, padding: "0 9px", borderRadius: 5,
              border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {t("取消")}
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
        display: "flex", alignItems: "center", gap: 7,
        height: 34, padding: "0 6px 0 26px", borderRadius: 5,
        cursor: busyRow ? "default" : "pointer",
        background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.1s",
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
            flex: 1, minWidth: 0, height: 24, fontSize: 12, padding: "2px 7px",
            border: "1px solid var(--accent)", borderRadius: 5, outline: "none",
            background: "var(--bg)", color: "var(--text)",
          }}
        />
      ) : (
        <>
          {running && <span style={{ width: 6, height: 6, borderRadius: 999, background: "#4ade80", flexShrink: 0 }} />}
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }} title={title}>
            {title}
          </span>
          {session.mode && session.mode !== "host" && (
            <span style={{ fontSize: 9, color: session.mode === "sandbox" ? "#38bdf8" : "#a78bfa", flexShrink: 0 }}>{session.mode === "sandbox" ? t("沙箱") : t("本机")}</span>
          )}
          <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{formatRelativeTime(new Date(session.modified).getTime())}</span>
          {canPin && hovered && (
            <button
              type="button"
              title={pinned ? t("取消置顶") : t("置顶")}
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              style={{ background: "transparent", border: "none", cursor: "pointer", padding: "0 2px", color: pinned ? "#f59e0b" : "var(--text-dim)", fontSize: 11, flexShrink: 0 }}
            >
              {pinned ? "★" : "☆"}
            </button>
          )}
          {!canPin && pinned && (
            <span style={{ color: "#f59e0b", fontSize: 11, flexShrink: 0 }}>★</span>
          )}
          {hovered && (
            <>
              <button
                type="button"
                title={t("重命名")}
                onClick={startRename}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0, background: "transparent",
                  border: "none", borderRadius: 5, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                type="button"
                title={t("删除会话")}
                onClick={(e) => { e.stopPropagation(); if (e.shiftKey) onDelete(); else setConfirmDelete(true); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0, background: "transparent",
                  border: "none", borderRadius: 5, color: "var(--text-dim)",
                  cursor: "pointer", flexShrink: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

