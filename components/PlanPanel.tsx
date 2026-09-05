"use client";

import ReactMarkdown from "react-markdown";
import type { SessionPlan } from "@/hooks/use-session-plan";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins } from "@/lib/markdown";

/**
 * 计划 — right-panel view of the session plan. The plan is probed by AppShell
 * (useSessionPlan): per-session file first (<cwd>/.pi/plans/plan-sess_<id>.md,
 * written by plan_save / @plan capture), legacy workspace plans
 * (.pi/plan.md / PLAN.md) as read-only fallback.
 */
export function PlanPanel({ plan }: { plan: SessionPlan | null }) {
  if (!plan) {
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
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={plan.path}>
        {plan.path}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div className="markdown-body markdown-file-preview" style={{ padding: "16px 20px" }}>
          <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>
            {plan.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
