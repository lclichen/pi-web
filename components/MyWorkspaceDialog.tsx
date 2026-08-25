"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface Props {
  onClose: () => void;
}

/**
 * 我的工作区 — 用户的云端文件留存（单向云盘）：浏览/上传/下载/删除。
 * 项目创建时可选择把工作区内容 seed 进新容器的 /workspace。
 */
export function MyWorkspaceDialog({ onClose }: Props) {
  const [wsId, setWsId] = useState<number | null>(null);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (id: number, p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${id}/files?path=${encodeURIComponent(p)}`);
      const d = (await res.json()) as { entries?: Entry[]; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setEntries(d.entries ?? []);
      setPath(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const res = await fetch("/api/workspaces");
        const d = (await res.json()) as { workspaces?: Array<{ id: number }>; error?: string };
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        const id = d.workspaces?.[0]?.id;
        if (stopped) return;
        if (id) await load(id, "/");
        else setError("工作区不可用");
        setWsId(id ?? null);
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { stopped = true; };
  }, [load]);

  const upload = async (file: File) => {
    if (!wsId || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/files?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file },
      );
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setNotice(`已上传 ${file.name}`);
      await load(wsId, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: Entry) => {
    if (!wsId || busy) return;
    if (!window.confirm(`删除 ${e.name}？`)) return;
    setBusy(true);
    setError(null);
    try {
      const target = `${path === "/" ? "" : path}/${e.name}`;
      const res = await fetch(`/api/workspaces/${wsId}/files?path=${encodeURIComponent(target)}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      await load(wsId, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openEntry = (e: Entry) => {
    if (!wsId) return;
    if (e.isDir) {
      void load(wsId, `${path === "/" ? "" : path}/${e.name}`);
    } else {
      window.open(
        `/api/workspaces/${wsId}/files?type=download&path=${encodeURIComponent(path)}&file=${encodeURIComponent(e.name)}`,
        "_blank",
        "noopener",
      );
    }
  };

  const goUp = () => {
    if (!wsId || path === "/") return;
    const idx = path.lastIndexOf("/");
    void load(wsId, idx <= 0 ? "/" : path.slice(0, idx));
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1180, display: "flex",
        alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 94vw)", height: "min(560px, 84vh)", display: "flex", flexDirection: "column",
          padding: "18px 20px", borderRadius: 12,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>我的工作区</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>云端文件留存 · 建项目时可初始化容器 /workspace</span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={goUp} disabled={path === "/" || busy} style={btnStyle}>↑ 上级</button>
          <button type="button" onClick={() => wsId && load(wsId, path)} disabled={loading || busy} style={btnStyle}>↻ 刷新</button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy || !wsId} style={{ ...btnStyle, color: "#fff", background: "var(--accent)", borderColor: "var(--accent)" }}>
            {busy ? "处理中…" : "上传文件"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <span style={{ flex: 1, minWidth: 0, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {path}
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
          {loading && <div style={muted}>加载中…</div>}
          {!loading && !error && entries.length === 0 && <div style={muted}>（空）上传文件或从项目导出后保存在这里。</div>}
          {error && <div style={{ ...muted, color: "#f87171" }}>{error}</div>}
          {notice && <div style={{ ...muted, color: "#4ade80" }}>{notice}</div>}
          {!loading && entries.map((e) => (
            <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 10px", borderBottom: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={() => openEntry(e)}
                style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, padding: "6px 0", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "var(--text)", fontSize: 12 }}
              >
                <span>{e.isDir ? "📁" : "📄"}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                {!e.isDir && <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{e.size >= 1048576 ? `${(e.size / 1048576).toFixed(1)}M` : e.size >= 1024 ? `${(e.size / 1024).toFixed(0)}K` : `${e.size}B`}</span>}
              </button>
              <button type="button" onClick={() => void remove(e)} disabled={busy} title="删除" style={{ ...btnStyle, padding: "0 6px", opacity: 0.7 }}>×</button>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          单文件上限 200MB；项目菜单「导出到工作区」可把容器 /workspace 打包保存到这里。
        </div>
      </div>
    </div>
  );
}

const btnStyle = {
  height: 28, padding: "0 10px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
} as const;

const closeBtnStyle = {
  background: "transparent", border: "none", color: "var(--text-muted)",
  cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 6px",
} as const;

const muted = { padding: "10px 12px", fontSize: 12, color: "var(--text-dim)" } as const;
