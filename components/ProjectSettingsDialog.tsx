"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ProjectRecord } from "@/lib/projects";

interface Props {
  projectId: string;
  onClose: () => void;
  onChanged: () => void;
}

interface ProjectDetail {
  project: ProjectRecord;
  modelsJson: string | null;
  authJson: string | null;
}

/**
 * 项目设置 — rename + 项目级模型凭证（models.json / auth.json，留空=继承
 * admin 全局层）。沙箱容器选择在项目菜单里（调 /api/sandbox/containers）。
 */
export function ProjectSettingsDialog({ projectId, onClose, onChanged }: Props) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [name, setName] = useState("");
  const [modelsJson, setModelsJson] = useState("");
  const [authJson, setAuthJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ProjectDetail) => {
        setDetail(d);
        setName(d.project.name);
        setModelsJson(d.modelsJson ?? "");
        setAuthJson(d.authJson ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !detail) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          modelsJson,
          authJson,
        }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1150, display: "flex",
        alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "min(620px, 92vw)", maxHeight: "86vh", overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 14,
          padding: "20px 22px", borderRadius: 12,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>项目设置</span>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted)" }}>
          项目名称
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted)" }}>
          models.json（项目级模型列表；留空 = 继承全局）
          <textarea
            value={modelsJson}
            onChange={(e) => setModelsJson(e.target.value)}
            placeholder='{"providers": {...}}'
            spellCheck={false}
            style={{ ...inputStyle, height: 120, fontFamily: "var(--font-mono)", resize: "vertical" }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted)" }}>
          auth.json（项目级模型凭证；留空 = 继承全局）
          <textarea
            value={authJson}
            onChange={(e) => setAuthJson(e.target.value)}
            placeholder='{"providers": {"anthropic": {"api_key": "..."}}}'
            spellCheck={false}
            style={{ ...inputStyle, height: 120, fontFamily: "var(--font-mono)", resize: "vertical" }}
          />
        </label>

        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          项目内存在这两个文件时会覆盖全局模型配置（仅对该项目的会话生效）；删除内容并保存即可恢复继承全局。
        </div>

        {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
        {saved && <div style={{ fontSize: 12, color: "#4ade80" }}>已保存。</div>}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={btnStyle}>关闭</button>
          <button type="submit" disabled={busy} style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" }}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputStyle = {
  height: 34, padding: "0 10px", borderRadius: 6,
  border: "1px solid var(--border)", background: "var(--bg)",
  color: "var(--text)", fontSize: 13, outline: "none",
} as const;

const btnStyle = {
  height: 32, padding: "0 14px", borderRadius: 7,
  border: "1px solid var(--border)", background: "var(--bg)",
  color: "var(--text-muted)", fontSize: 12, cursor: "pointer",
} as const;
