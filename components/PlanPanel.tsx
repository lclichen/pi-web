"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { SessionPlan } from "@/hooks/use-session-plan";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins } from "@/lib/markdown";

interface PlanVersion {
  toolCallId: string;
  savedAt: number | null;
  chars: number;
  preview: string;
  content: string;
}

interface Props {
  plan: SessionPlan | null;
  /** Owning session id — powers the plan_save version history. */
  sessionId?: string | null;
}

/**
 * 计划 — right-panel view of the session plan. The plan is probed by AppShell
 * (useSessionPlan): per-session file first (<cwd>/.pi/plans/plan-sess_<id>.md,
 * written by plan_save / @plan capture), legacy workspace plans
 * (.pi/plan.md / PLAN.md) as read-only fallback.
 *
 * Version history (ZCode parity): every plan_save call in the session file is
 * listed by /api/sessions/{id}/plan-versions — the header switcher jumps
 * between historical revisions; the live file stays the default view.
 */
export function PlanPanel({ plan, sessionId }: Props) {
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [picked, setPicked] = useState("live");

  useEffect(() => {
    setVersions([]);
    setPicked("live");
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan-versions`);
        if (!res.ok || cancelled) return;
        const d = (await res.json()) as { versions?: PlanVersion[] };
        if (!cancelled) setVersions(d.versions ?? []);
      } catch {
        // offline — history stays empty, live plan unaffected
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const pickedVersion = useMemo(
    () => versions.find((v) => v.toolCallId === picked) ?? null,
    [versions, picked],
  );

  const emptyPlan = !plan && versions.length === 0;
  if (emptyPlan) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>未找到计划</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: "18px" }}>
          会话中让模型调用 plan_save，或运行 @plan 子智能体，<br />
          计划会保存到 .pi/plans/plan-sess_&lt;会话ID&gt;.md 并显示在这里
        </div>
      </div>
    );
  }

  const content = pickedVersion ? pickedVersion.content : plan?.content ?? "";
  const headerPath = pickedVersion
    ? `${plan?.path ?? ".pi/plans/"} · 历史版本 v${versions.indexOf(pickedVersion) + 1}/${versions.length}`
    : plan?.path ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 14px", fontSize: 11, color: "var(--text-dim)",
        fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)",
        flexShrink: 0, overflow: "hidden",
      }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={headerPath}>
          {headerPath}
        </span>
        {versions.length > 0 && (
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="计划版本"
            title="切换计划版本"
            style={{
              flexShrink: 0, maxWidth: 132, fontSize: 10, padding: "2px 4px",
              background: "var(--bg-panel)", color: "var(--text-muted)",
              border: "1px solid var(--border)", borderRadius: 5, outline: "none",
            }}
          >
            <option value="live">当前文件{plan ? "" : "（缺失）"}</option>
            {[...versions].reverse().map((v, i) => (
              <option key={v.toolCallId} value={v.toolCallId}>
                {`v${versions.length - i} · ${v.preview.slice(0, 14)}`}
              </option>
            ))}
          </select>
        )}
      </div>
      {pickedVersion && (
        <div style={{ padding: "4px 14px", fontSize: 10, color: "var(--text-dim)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          历史版本只读——保存于 {pickedVersion.savedAt ? new Date(pickedVersion.savedAt).toLocaleString() : "未知时间"}（{pickedVersion.chars} 字符）
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div className="markdown-body markdown-file-preview" style={{ padding: "16px 20px" }}>
          {content ? (
            <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>
              {content}
            </ReactMarkdown>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>该版本无内容</div>
          )}
        </div>
      </div>
    </div>
  );
}
