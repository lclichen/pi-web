"use client";

import { useCallback, useEffect, useState } from "react";

interface Props {
  mode: "sandbox" | "local-machine";
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { name: string; imageId?: number; workspaceInit: boolean }) => void;
}

interface ImageEntry {
  id: number;
  name: string;
  defaultResources: { cpu: number; memoryMb: number; diskGb: number } | null;
}

interface WorkspaceEntry {
  id: number;
  name: string;
}

/**
 * 新建项目对话框 — 名称必填；沙箱模式额外选择运行环境（公开镜像）与
 * “从我的工作区初始化 /workspace”（云盘单向 seed）。本机模式只有名称。
 */
export function NewProjectDialog({ mode, busy, onCancel, onCreate }: Props) {
  const [name, setName] = useState("");
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [imageId, setImageId] = useState<number | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [workspaceInit, setWorkspaceInit] = useState(false);
  const [loading, setLoading] = useState(mode === "sandbox");

  useEffect(() => {
    if (mode !== "sandbox") return;
    let stopped = false;
    (async () => {
      try {
        // 镜像列表来自沙箱容器 BFF（同一响应里已含公共镜像与默认供给）。
        const res = await fetch("/api/sandbox/containers");
        const d = (await res.json()) as { images?: ImageEntry[] };
        if (stopped) return;
        setImages(d.images ?? []);
        setImageId(d.images?.[0]?.id ?? null);
      } catch {
        // 镜像列表失败不阻塞创建（服务端会用平台默认镜像）。
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => { stopped = true; };
  }, [mode]);

  useEffect(() => {
    if (mode !== "sandbox") return;
    let stopped = false;
    fetch("/api/workspaces")
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d: { workspaces?: WorkspaceEntry[] }) => {
        if (!stopped) setWorkspaces(d.workspaces ?? []);
      })
      .catch(() => {});
    return () => { stopped = true; };
  }, [mode]);

  const submit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    onCreate({
      name: trimmed,
      ...(mode === "sandbox" && imageId != null ? { imageId } : {}),
      workspaceInit: mode === "sandbox" && workspaceInit && workspaces.length > 0,
    });
  }, [name, busy, onCreate, mode, imageId, workspaceInit, workspaces.length]);

  const hasWorkspace = workspaces.length > 0;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1180, display: "flex",
        alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(440px, 92vw)", display: "flex", flexDirection: "column", gap: 12,
          padding: "20px 22px", borderRadius: 12,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {mode === "sandbox" ? "新建沙箱项目" : "新建本机项目"}
          </span>
          <button type="button" onClick={onCancel} disabled={busy} style={closeBtnStyle}>×</button>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
          项目名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="如：lab1-hello"
            autoFocus
            disabled={busy}
            style={inputStyle}
          />
        </label>

        {mode === "sandbox" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            运行环境{loading ? "（加载中…）" : ""}
            <select
              value={imageId ?? ""}
              onChange={(e) => setImageId(Number(e.target.value))}
              disabled={busy || loading || images.length === 0}
              style={inputStyle}
            >
              {images.length === 0 && <option value="">（平台默认）</option>}
              {images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.defaultResources ? ` · ${i.defaultResources.cpu}C/${i.defaultResources.memoryMb}M/${i.defaultResources.diskGb}G` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {mode === "sandbox" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", cursor: hasWorkspace ? "pointer" : "default", opacity: hasWorkspace ? 1 : 0.5 }}>
            <input
              type="checkbox"
              checked={workspaceInit}
              disabled={busy || !hasWorkspace}
              onChange={(e) => setWorkspaceInit(e.target.checked)}
            />
            <span>
              从我的工作区初始化 /workspace
              <span style={{ display: "block", fontSize: 10.5, color: "var(--text-dim)" }}>
                {hasWorkspace ? "把云端文件拷入新容器（仅创建时，容器内改动不回写）" : "（暂无工作区，创建后可在「我的工作区」上传）"}
              </span>
            </span>
          </label>
        )}

        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {mode === "sandbox"
            ? "创建时自动准备容器（约数秒），会话在容器 /workspace 内执行。"
            : "项目会话通过本机 Agent 在你配对的工作区内执行。"}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtn}>取消</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim()}
            style={{ ...secondaryBtn, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", fontWeight: 600 }}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  height: 32, padding: "0 8px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
} as const;

const secondaryBtn = {
  height: 30, padding: "0 14px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer",
} as const;

const closeBtnStyle = {
  background: "transparent", border: "none", color: "var(--text-muted)",
  cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 6px",
} as const;
