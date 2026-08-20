"use client";

import { useCallback, useEffect, useState } from "react";

interface Props {
  /** When opened from a project menu: that project, so rows offer binding. */
  bind?: { projectId: string; projectName: string; containerId?: number } | null;
  onClose: () => void;
  /** Called after the bound project's container changed (refresh the tree). */
  onChanged?: () => void;
}

interface ContainerEntry {
  id: number;
  name: string;
  status: string;
}

interface ImageEntry {
  id: number;
  name: string;
  defaultResources: { cpu: number; memoryMb: number; diskGb: number } | null;
}

interface ListResponse {
  containers: ContainerEntry[];
  images: ImageEntry[];
  defaults: { imageId: number; imageName: string } | null;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: "运行中", color: "#22c55e" },
  stopped: { label: "已停止", color: "#9ca3af" },
  creating: { label: "创建中", color: "#f59e0b" },
  deleting: { label: "删除中", color: "#f59e0b" },
};

/**
 * 沙箱容器管理 — 用户对自己平台容器的友好管理入口：查看全部状态、从公共
 * 镜像新建、启动/停止、删除，以及（从项目菜单打开时）一键绑定到项目。
 * 数据经 pi-web BFF（/api/sandbox/containers）携带该用户的平台密钥。
 */
export function SandboxManagerDialog({ bind, onClose, onChanged }: Props) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createImageId, setCreateImageId] = useState<number | null>(null);
  const [createName, setCreateName] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sandbox/containers");
      const d = (await res.json()) as ListResponse & { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Default the create form to the platform's provisioning default image.
  useEffect(() => {
    if (createImageId === null && data) {
      setCreateImageId(data.defaults?.imageId ?? data.images[0]?.id ?? null);
    }
  }, [data, createImageId]);

  const act = async (fn: () => Promise<void>, id: number | "create") => {
    if (busyId !== null) return;
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const post = (body: Record<string, unknown>) =>
    fetch("/api/sandbox/containers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const d = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    });

  const remove = async (c: ContainerEntry) => {
    if (!window.confirm(`删除容器 ${c.name} (#${c.id})？容器内的文件将不可恢复。`)) return;
    await act(
      () =>
        fetch(`/api/sandbox/containers?containerId=${c.id}`, { method: "DELETE" }).then(async (r) => {
          const d = (await r.json()) as { error?: string };
          if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
        }),
      c.id,
    );
  };

  const bindToProject = async (c: ContainerEntry) => {
    if (!bind) return;
    await act(async () => {
      const res = await fetch(`/api/projects/${encodeURIComponent(bind.projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ containerId: c.id }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setNotice(`已将容器 #${c.id} 绑定到项目「${bind.projectName}」，该项目的新会话将在该容器中运行。`);
      onChanged?.();
    }, c.id);
  };

  const containers = data?.containers ?? [];
  const images = data?.images ?? [];

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1150, display: "flex",
        alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 92vw)", maxHeight: "86vh", overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 14,
          padding: "20px 22px", borderRadius: 12,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            沙箱容器管理
            {bind && <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)" }}> — 项目「{bind.projectName}」</span>}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" onClick={() => void load()} disabled={loading || busyId !== null} style={smallBtnStyle}>
              刷新
            </button>
            <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
        </div>

        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          停止会保留容器内的文件（下次启动恢复）；删除不可恢复。空闲容器也可能被平台按策略自动停止。
        </div>

        {loading && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>}
        {!loading && containers.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>还没有容器，用下方表单创建一个。</div>
        )}

        {containers.map((c) => {
          const meta = STATUS_META[c.status] ?? { label: c.status, color: "#f59e0b" };
          const isBound = bind && bind.containerId === c.id;
          return (
            <div
              key={c.id}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                border: "1px solid var(--border)", borderRadius: 8,
                background: isBound ? "var(--bg-selected, rgba(79,124,255,0.08))" : "transparent",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.name} <span style={{ color: "var(--text-dim)" }}>#{c.id}</span>
                  {isBound && <span style={{ color: "var(--accent)", marginLeft: 6 }}>当前项目容器</span>}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{meta.label}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {bind && !isBound && (
                  <button type="button" disabled={busyId !== null} onClick={() => void bindToProject(c)} style={smallBtnStyle}>
                    绑定
                  </button>
                )}
                {c.status === "running" ? (
                  <button type="button" disabled={busyId !== null} onClick={() => void act(() => post({ action: "stop", containerId: c.id }), c.id)} style={smallBtnStyle}>
                    停止
                  </button>
                ) : c.status === "stopped" ? (
                  <button type="button" disabled={busyId !== null} onClick={() => void act(() => post({ action: "start", containerId: c.id }), c.id)} style={smallBtnStyle}>
                    启动
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void remove(c)}
                  style={{ ...smallBtnStyle, color: "#f87171", borderColor: "#f8717155" }}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}

        {images.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>新建容器</span>
            <div style={{ display: "flex", gap: 8 }}>
              <select
                value={createImageId ?? ""}
                onChange={(e) => setCreateImageId(Number(e.target.value))}
                style={{ ...inputStyle, flex: 1 }}
              >
                {images.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="名称（可选）"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                disabled={busyId !== null || createImageId === null}
                onClick={() =>
                  void act(async () => {
                    await post({ action: "create", imageId: createImageId, ...(createName.trim() ? { name: createName.trim() } : {}) });
                    setCreateName("");
                    setNotice("容器已创建并启动。");
                  }, "create")
                }
                style={{ ...smallBtnStyle, color: "white", background: "var(--accent)", borderColor: "var(--accent)" }}
              >
                {busyId === "create" ? "创建中…" : "创建"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              资源用量按镜像默认/个人配额分配；创建后立即可在沙箱项目里绑定使用。
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
        {notice && <div style={{ fontSize: 12, color: "#4ade80" }}>{notice}</div>}
      </div>
    </div>
  );
}

const inputStyle = {
  height: 30,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
} as const;

const smallBtnStyle = {
  height: 26,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;
