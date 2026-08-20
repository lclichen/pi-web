"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>;
  refreshSessions: () => void;
  isAdmin: boolean;
  sessionSpace: "mine" | "host";
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
export function ProjectSessionTree({
  sessions,
  runningSessionIds,
  selectedSessionId,
  onSelectSession,
  onNewSessionInProject,
  onDeleteSession,
  onRenameSession,
  refreshSessions,
  isAdmin,
  sessionSpace,
  onOpenServerDirectory,
  onManageSandbox,
  projectsRefreshKey,
}: Props) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ project: ProjectRecord; x: number; y: number } | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [containers, setContainers] = useState<Array<{ id: number; name: string }>>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const loadProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((d: { projects?: ProjectRecord[] }) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects, projectsRefreshKey]);

  // Running-container list for the sandbox container picker (admin/user alike).
  useEffect(() => {
    if (menu?.project.mode !== "sandbox") return;
    fetch("/api/sandbox/containers")
      .then((r) => (r.ok ? r.json() : { containers: [] }))
      .then((d: { containers?: Array<{ id: number; name: string }> }) => setContainers(d.containers ?? []))
      .catch(() => setContainers([]));
  }, [menu]);

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

  const remove = async (project: ProjectRecord) => {
    if (!window.confirm(`删除项目「${project.name}」及其配置目录？（会话记录保留）`)) return;
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

  const createProject = async (mode: "sandbox" | "local-machine") => {
    const name = window.prompt(mode === "sandbox" ? "新沙箱项目名称：" : "新本机项目名称：");
    if (!name?.trim()) return;
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), mode }),
    }).catch(() => {});
    loadProjects();
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

  const hostGroups = useMemo(() => {
    if (!isAdmin || sessionSpace !== "host") return [];
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
  }, [byProject.ungrouped, isAdmin, sessionSpace]);

  const renderItem = (s: SessionInfo, project: ProjectRecord | null) => {
    const selected = s.id === selectedSessionId;
    const running = runningSessionIds.has(s.id);
    const pinned = project?.pinnedSessions.includes(s.id) ?? false;
    return (
      <div
        key={s.id}
        onClick={() => onSelectSession(s)}
        onDoubleClick={() => {
          const name = window.prompt("重命名会话：", s.name ?? "");
          if (name?.trim()) void onRenameSession(s.id, name.trim());
        }}
        style={{
          display: "flex", alignItems: "center", gap: 7,
          height: 34, padding: "0 6px 0 26px", borderRadius: 5, cursor: "pointer",
          background: selected ? "var(--bg-selected)" : "transparent",
        }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
      >
        {running && <span style={{ width: 6, height: 6, borderRadius: 999, background: "#4ade80", flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
          {s.name || s.firstMessage.slice(0, 40) || s.id.slice(0, 8)}
        </span>
        {s.mode && s.mode !== "host" && (
          <span style={{ fontSize: 9, color: s.mode === "sandbox" ? "#38bdf8" : "#a78bfa", flexShrink: 0 }}>{s.mode === "sandbox" ? "沙箱" : "本机"}</span>
        )}
        <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{formatRelativeTime(new Date(s.modified).getTime())}</span>
        <button
          type="button"
          title={pinned ? "取消置顶" : "置顶"}
          onClick={(e) => { e.stopPropagation(); if (project) void pin(project, s.id, pinned); }}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "0 2px", color: pinned ? "#f59e0b" : "var(--text-dim)", fontSize: 11, flexShrink: 0, visibility: project ? "visible" : "hidden" }}
        >
          {pinned ? "★" : "☆"}
        </button>
        <button
          type="button"
          title="删除会话"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm("删除此会话？")) void onDeleteSession(s.id);
          }}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: "0 2px", color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}
        >
          ×
        </button>
      </div>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 4px" }}>
      {/* 新建项目入口 */}
      <div style={{ display: "flex", gap: 6, padding: "0 4px 8px" }}>
        <button type="button" onClick={() => void createProject("sandbox")} style={createBtn}>+ 沙箱项目</button>
        <button type="button" onClick={() => void createProject("local-machine")} style={createBtn}>+ 本机项目</button>
        {isAdmin && onOpenServerDirectory && (
          <button type="button" onClick={onOpenServerDirectory} style={{ ...createBtn, marginLeft: "auto" }}>打开服务器目录</button>
        )}
      </div>

      {projects.map((project) => {
        const { visible, total } = projectSessions(project);
        const isCollapsed = collapsed.has(project.id);
        return (
          <div key={project.id} style={{ marginBottom: 2 }}>
            <div
              onClick={() => toggleCollapsed(project.id)}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "5px 6px",
                borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600,
                color: "var(--text)", background: "var(--bg-panel)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-selected)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
            >
              <span style={{ fontSize: 9, color: "var(--text-dim)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</span>
              {project.mode === "sandbox" && <span style={{ fontSize: 9, color: "#38bdf8" }}>沙箱</span>}
              {project.mode === "local-machine" && <span style={{ fontSize: 9, color: "#a78bfa" }}>本机</span>}
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{total}</span>
              <button
                type="button"
                title="新建会话"
                onClick={(e) => { e.stopPropagation(); onNewSessionInProject(project); }}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 13, padding: "0 3px" }}
              >＋</button>
              <button
                type="button"
                title="项目菜单"
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
                    显示全部 {total} 个会话
                  </button>
                )}
                {total === 0 && (
                  <div style={{ padding: "4px 6px 6px 26px", fontSize: 11, color: "var(--text-dim)" }}>暂无会话，点 ＋ 新建</div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {projects.length === 0 && (
        <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--text-dim)" }}>还没有项目——点上方按钮创建第一个。</div>
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
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={root}>{root}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{list.length}</span>
            </div>
            {visible.map((s) => renderItem(s, null))}
            {!isCollapsed && list.length > RECENT_COUNT && (
              <button type="button" onClick={() => setShowAll((prev) => new Set(prev).add(key))} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 11, padding: "2px 6px 2px 26px" }}>
                显示全部 {list.length} 个会话
              </button>
            )}
          </div>
        );
      })}

      {/* 项目菜单 */}
      {menu && (
        <div
          ref={menuRef}
          style={{
            position: "fixed", top: menu.y, left: Math.max(8, menu.x - 160), zIndex: 1200,
            display: "flex", flexDirection: "column", minWidth: 160,
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)", overflow: "hidden", fontSize: 12,
          }}
        >
          <MenuItem label="新建会话" onClick={() => { onNewSessionInProject(menu.project); setMenu(null); }} />
          <MenuItem label="重命名" onClick={() => {
            const name = window.prompt("项目新名称：", menu.project.name);
            if (name?.trim()) {
              void fetch(`/api/projects/${encodeURIComponent(menu.project.id)}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
              }).then(() => loadProjects());
            }
            setMenu(null);
          }} />
          <MenuItem label="复制为新项目" onClick={() => { void duplicate(menu.project); setMenu(null); }} />
          <MenuItem label="设置（模型凭证等）" onClick={() => { setSettingsId(menu.project.id); setMenu(null); }} />
          <MenuItem label="导入项目配置…" onClick={() => { setImportId(menu.project.id); setMenu(null); }} />
          {menu.project.mode === "sandbox" && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "4px 10px", color: "var(--text-dim)", fontSize: 10 }}>沙箱容器</div>
          )}
          {menu.project.mode === "sandbox" && containers.map((c) => (
            <MenuItem
              key={c.id}
              label={`${menu.project.containerId === c.id ? "● " : "○ "}${c.name} (#${c.id})`}
              onClick={() => void setContainer(menu.project, c.id)}
            />
          ))}
          {menu.project.mode === "sandbox" && (
            <MenuItem label="跟随平台默认容器" onClick={() => void setContainer(menu.project, null)} />
          )}
          {menu.project.mode === "sandbox" && onManageSandbox && (
            <MenuItem label="管理沙箱容器（新建/启停/删除）…" onClick={() => { onManageSandbox(menu.project); setMenu(null); }} />
          )}
          <div style={{ borderTop: "1px solid var(--border)" }} />
          <MenuItem label="删除项目" danger onClick={() => { void remove(menu.project); setMenu(null); }} />
        </div>
      )}

      {settingsId && (
        <ProjectSettingsDialog
          projectId={settingsId}
          onClose={() => setSettingsId(null)}
          onChanged={() => { loadProjects(); refreshSessions(); }}
        />
      )}

      {importId && (
        <ProjectImportDialog
          projectName={projects.find((p) => p.id === importId)?.name ?? importId}
          onClose={() => setImportId(null)}
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

const createBtn = {
  flex: 1, height: 28, borderRadius: 7, fontSize: 11, cursor: "pointer",
  background: "var(--bg)", color: "var(--text-muted)", border: "1px solid var(--border)",
} as const;
