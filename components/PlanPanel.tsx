"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins } from "@/lib/markdown";

interface RemoteCtx { sessionId: string; label: string }

/**
 * 计划 — right-panel view of the workspace plan file (`.pi/plan.md`, falling
 * back to `PLAN.md`), live-refreshed. Remote sessions (sandbox/local) read
 * through /api/remotefs so the plan is fetched from the container workspace,
 * not the server project home.
 */
export function PlanPanel({ cwd, remote }: { cwd?: string; remote?: RemoteCtx | null }) {
  const [content, setContent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cwd && !remote) {
      setContent(null); setPath(null); setLoading(false);
      return;
    }
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const root = (cwd ?? "").replace(/[\\/]+$/, "");
    const candidates = [`${root}/.pi/plan.md`, `${root}/PLAN.md`];
    const src = remote ? `?src=${encodeURIComponent(remote.sessionId)}` : "";
    const readUrl = (candidate: string, type: string): string =>
      remote
        ? `/api/remotefs/${encodeFilePathForApi(candidate.replace(/^\//, ""))}${src}&type=${type}`
        : `/api/files/${encodeFilePathForApi(candidate)}?type=${type}`;

    const tryRead = async (index: number): Promise<void> => {
      if (cancelled) return;
      if (index >= candidates.length) {
        setContent(null); setPath(null); setLoading(false);
        return;
      }
      const candidate = candidates[index];
      try {
        const res = await fetch(readUrl(candidate, "read"));
        if (!res.ok) { await tryRead(index + 1); return; }
        const d = (await res.json()) as { content?: string };
        if (cancelled) return;
        if (typeof d.content !== "string") { await tryRead(index + 1); return; }
        setContent(d.content);
        setPath(candidate);
        setLoading(false);
        if (remote) {
          pollTimer = setInterval(async () => {
            if (cancelled) return;
            try {
              const r = await fetch(readUrl(candidate, "read"));
              if (!r.ok) return;
              const next = (await r.json()) as { content?: string };
              if (!cancelled && typeof next.content === "string") setContent(next.content);
            } catch { /* keep */ }
          }, 10_000);
        } else {
          es = new EventSource(readUrl(candidate, "watch"));
          es.addEventListener("change", () => {
            void (async () => {
              try {
                const r = await fetch(readUrl(candidate, "read"));
                if (!r.ok) return;
                const next = (await r.json()) as { content?: string };
                if (!cancelled && typeof next.content === "string") setContent(next.content);
              } catch { /* keep */ }
            })();
          });
        }
      } catch { await tryRead(index + 1); }
    };
    setLoading(true);
    void tryRead(0);

    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [cwd, remote]);

  if (loading) {
    return <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>加载计划…</div>;
  }
  if (content === null) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>未找到计划文件</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          在工作区创建 .pi/plan.md 或 PLAN.md 后，聊天区右上角的「计划」chip 会显示其摘要
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path ?? undefined}>
        {remote ? `${remote.label} · ${path}` : path}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div className="markdown-body markdown-file-preview" style={{ padding: "16px 20px" }}>
          <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
