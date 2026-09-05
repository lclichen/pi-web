"use client";

import { useCallback, useEffect, useState } from "react";
import type { GitFileStatus, GitStatusResponse } from "@/lib/git-types";
import { MarkdownBody } from "@/components/MarkdownBody";

interface BranchInfo {
  current: string | null;
  ahead: number;
  behind: number;
  tracking: string | null;
}

interface GitLogEntry {
  hash: string;
  short: string;
  subject: string;
  author: string;
  relTime: string;
  refs: string;
  graph: string;
}

interface Props {
  cwd: string;
  /** Selected session id — provides the model for AI review / commit messages. */
  sessionId?: string | null;
  refreshKey?: number;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: "#f59e0b",
  A: "#22c55e",
  D: "#ef4444",
  R: "#3b82f6",
  U: "#a855f7",
  C: "#a855f7",
  "?": "#6b7280",
};

function statusLetter(code: string): string {
  if (code === "??") return "?";
  return code.trim().charAt(0) || "?";
}

function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : filePath;
}

type InsightMode = "review" | "commit-message";

export function GitPanel({ cwd, sessionId, refreshKey, onClose }: Props) {
  const [view, setView] = useState<"changes" | "history">("changes");
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [log, setLog] = useState<GitLogEntry[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // AI insight state
  const [review, setReview] = useState<string | null>(null);
  const [insightBusy, setInsightBusy] = useState<InsightMode | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [sRes, bRes] = await Promise.all([
        fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json() as Promise<GitStatusResponse>),
        fetch(`/api/git/branch?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json() as Promise<BranchInfo>),
      ]);
      setStatus(sRes);
      setBranch(bRes);

      // Pre-populate staged set from index status
      const newStaged = new Set<string>();
      if (sRes.isGitRepository) {
        for (const f of sRes.files) {
          if (f.indexStatus && f.indexStatus !== " " && f.indexStatus !== "?") {
            newStaged.add(f.filePath);
          }
        }
      }
      setStaged(newStaged);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const loadHistory = useCallback(async () => {
    setLogError(null);
    try {
      const res = await fetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=150`);
      const data = (await res.json()) as { success?: boolean; commits?: GitLogEntry[]; error?: string };
      if (!res.ok || !data.success) {
        setLogError(data.error ?? `HTTP ${res.status}`);
        setLog(null);
        return;
      }
      setLog(data.commits ?? []);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);
  useEffect(() => { if (view === "history" && log === null && !logError) void loadHistory(); }, [view, log, logError, loadHistory]);

  const showResult = useCallback((ok: boolean, msg: string) => {
    setResult({ ok, msg });
    setTimeout(() => setResult(null), 4000);
  }, []);

  const doOp = useCallback(async (name: string, fn: () => Promise<Response>) => {
    setBusy(name);
    setResult(null);
    try {
      const res = await fn();
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data.success || data.commitHash)) {
        showResult(true, data.message || data.output || `${name} succeeded`);
        await refresh();
      } else {
        showResult(false, data.error || `${name} failed (HTTP ${res.status})`);
      }
    } catch (e) {
      showResult(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh, showResult]);

  const runInsight = useCallback(async (mode: InsightMode) => {
    if (!sessionId) {
      setInsightError("AI 审查需要一个会话提供模型：请先在左侧选择或创建一个会话");
      return;
    }
    setInsightBusy(mode);
    setInsightError(null);
    try {
      const res = await fetch("/api/git/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, cwd, mode }),
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok || typeof data.text !== "string") {
        setInsightError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      if (mode === "commit-message") {
        setCommitMsg(data.text);
      } else {
        setReview(data.text);
      }
    } catch (e) {
      setInsightError(e instanceof Error ? e.message : String(e));
    } finally {
      setInsightBusy(null);
    }
  }, [sessionId, cwd]);

  const toggleStage = useCallback((filePath: string) => {
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const stageAll = useCallback(() => {
    if (!status) return;
    setStaged(new Set(status.files.map((f) => f.filePath)));
  }, [status]);

  const unstageAll = useCallback(() => {
    setStaged(new Set());
  }, []);

  const handleStageAndCommit = useCallback(async () => {
    if (!commitMsg.trim()) { showResult(false, "Commit message required"); return; }
    const files = Array.from(staged);
    await doOp("commit", () =>
      fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, message: commitMsg.trim(), files }),
      }),
    );
    if (busy === null) setCommitMsg("");
  }, [commitMsg, staged, cwd, doOp]);

  const handleStage = useCallback(async () => {
    const files = Array.from(staged);
    await doOp("stage", () =>
      fetch("/api/git/stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, files }),
      }),
    );
  }, [staged, cwd, doOp]);

  const handleUnstage = useCallback(async () => {
    const files = Array.from(staged);
    await doOp("unstage", () =>
      fetch("/api/git/unstage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, files }),
      }),
    );
  }, [staged, cwd, doOp]);

  const handlePush = useCallback(() =>
    doOp("push", () => fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) })),
    [doOp, cwd]);

  const handlePull = useCallback(() =>
    doOp("pull", () => fetch("/api/git/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) })),
    [doOp, cwd]);

  const handleFetch = useCallback(() =>
    doOp("fetch", () => fetch("/api/git/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) })),
    [doOp, cwd]);

  if (loading) {
    return <div style={{ padding: 12, fontSize: 11, color: "var(--text-dim)" }}>Loading git status...</div>;
  }

  if (error || !status) {
    return <div style={{ padding: 12, fontSize: 11, color: "#f87171" }}>{error ?? "Failed to load git status"}</div>;
  }

  if (!status.isGitRepository) {
    return <div style={{ padding: 12, fontSize: 11, color: "var(--text-dim)" }}>Not a git repository</div>;
  }

  const files = status.files;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header: branch + view switch + remote ops */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)", flexShrink: 0 }}>
          <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9v2c0 2-2 3-4 3H9" /><path d="M6 9v6" />
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
          {branch?.current ?? "detached HEAD"}
        </span>
        {branch?.tracking && (
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{branch.tracking}</span>
        )}
        {(branch?.ahead ?? 0) > 0 && (
          <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 600 }}>{branch!.ahead} ahead</span>
        )}
        {(branch?.behind ?? 0) > 0 && (
          <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 600 }}>{branch!.behind} behind</span>
        )}
        <div style={{ width: 6 }} />
        {/* 更改 / 历史 view switch */}
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 999, overflow: "hidden", flexShrink: 0 }}>
          {(["changes", "history"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                border: "none", padding: "1px 9px", fontSize: 10, fontWeight: 600, cursor: "pointer",
                background: view === v ? "var(--accent)" : "transparent",
                color: view === v ? "#fff" : "var(--text-dim)",
              }}
            >
              {v === "changes" ? "更改" : "历史"}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {view === "changes" && (
          <>
            <button onClick={handleFetch} disabled={!!busy} title="Fetch all remotes" style={btnStyle("var(--bg-panel)")}>
              {busy === "fetch" ? "..." : "Fetch"}
            </button>
            <button onClick={handlePull} disabled={!!busy} title="Pull from remote" style={btnStyle("var(--bg-panel)")}>
              {busy === "pull" ? "..." : "Pull"}
            </button>
            <button onClick={handlePush} disabled={!!busy} title="Push to remote" style={btnStyle("var(--accent)", "#fff")}>
              {busy === "push" ? "..." : "Push"}
            </button>
          </>
        )}
        {view === "history" && (
          <button onClick={() => { setLog(null); void loadHistory(); }} disabled={insightBusy !== null} title="刷新提交历史" style={btnStyle("var(--bg-panel)")}>
            刷新
          </button>
        )}
        <button onClick={onClose} title="Close" style={{ ...btnStyle("var(--bg-panel)"), padding: "0 6px" }}>x</button>
      </div>

      {/* Result message */}
      {result && (
        <div style={{
          padding: "4px 10px", fontSize: 10,
          color: result.ok ? "#22c55e" : "#f87171",
          background: result.ok ? "rgba(34,197,94,0.08)" : "rgba(248,113,113,0.08)",
          borderBottom: "1px solid var(--border)",
          whiteSpace: "pre-wrap", maxHeight: 60, overflow: "auto",
          flexShrink: 0,
        }}>
          {result.msg}
        </div>
      )}

      {view === "changes" ? (
        <>
          {/* Changed files list */}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {files.length === 0 ? (
              <div style={{ padding: "20px 12px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
                Working tree clean
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>
                    {files.length} changed {files.length === 1 ? "file" : "files"}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button onClick={stageAll} style={miniBtn}>Stage all</button>
                  <button onClick={unstageAll} style={miniBtn}>Unstage all</button>
                </div>
                {files.map((f) => {
                  const isStaged = staged.has(f.filePath);
                  const letter = statusLetter(f.indexStatus !== " " && f.indexStatus !== "?" ? f.indexStatus : (f.worktreeStatus || "?"));
                  return (
                    <div
                      key={f.filePath}
                      onClick={() => toggleStage(f.filePath)}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "3px 10px", cursor: "pointer", fontSize: 11,
                        background: isStaged ? "rgba(59,130,246,0.08)" : "transparent",
                      }}
                      onMouseEnter={(e) => { if (!isStaged) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!isStaged) e.currentTarget.style.background = "transparent"; }}
                    >
                      <div style={{
                        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                        border: `1.5px solid ${isStaged ? "var(--accent)" : "var(--text-dim)"}`,
                        background: isStaged ? "var(--accent)" : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {isStaged && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M3 8l3.5 3.5L13 4" /></svg>}
                      </div>
                      <span style={{
                        fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10,
                        color: STATUS_COLORS[letter] ?? "var(--text-muted)",
                        flexShrink: 0, width: 14, textAlign: "center",
                      }}>
                        {letter}
                      </span>
                      <span style={{
                        flex: 1, minWidth: 0,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        color: "var(--text)",
                      }} title={f.filePath}>
                        {shortPath(f.filePath)}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* AI review result */}
          {(review || insightError) && (
            <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0, maxHeight: 220, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)" }}>AI 审查</span>
                <div style={{ flex: 1 }} />
                <button onClick={() => setReview(null)} style={miniBtn}>收起</button>
              </div>
              <div style={{ overflowY: "auto", padding: "6px 12px", fontSize: 11 }}>
                {insightError ? (
                  <span style={{ color: "#f87171", whiteSpace: "pre-wrap" }}>{insightError}</span>
                ) : (
                  <MarkdownBody className="git-review-body">{review ?? ""}</MarkdownBody>
                )}
              </div>
            </div>
          )}

          {/* Commit area */}
          <div style={{ borderTop: "1px solid var(--border)", padding: 8, flexShrink: 0 }}>
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message..."
              rows={2}
              spellCheck={false}
              style={{
                width: "100%", resize: "none",
                border: "1px solid var(--border)", borderRadius: 4,
                background: "var(--bg)", color: "var(--text)",
                fontSize: 11, padding: "4px 8px", outline: "none",
                fontFamily: "var(--font-mono)",
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleStageAndCommit();
              }}
            />
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <button
                onClick={handleStageAndCommit}
                disabled={!!busy || !commitMsg.trim()}
                style={{
                  ...btnStyle("var(--accent)", "#fff"),
                  flex: 1, fontWeight: 600,
                  opacity: busy || !commitMsg.trim() ? 0.5 : 1,
                  cursor: busy || !commitMsg.trim() ? "default" : "pointer",
                }}
              >
                {busy === "commit" ? "Committing..." : staged.size > 0 ? `Commit (${staged.size})` : "Commit all"}
              </button>
              <button onClick={handleStage} disabled={!!busy || staged.size === 0} style={btnStyle("var(--bg-panel)")}>Stage</button>
              <button onClick={handleUnstage} disabled={!!busy || staged.size === 0} style={btnStyle("var(--bg-panel)")}>Unstage</button>
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <button
                onClick={() => void runInsight("review")}
                disabled={insightBusy !== null || files.length === 0}
                title={sessionId ? "调用当前会话的模型审查工作区改动" : "需要先选择一个会话提供模型"}
                style={{
                  ...btnStyle("var(--bg-panel)"),
                  flex: 1,
                  color: "var(--accent)",
                  borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))",
                  opacity: insightBusy !== null || files.length === 0 ? 0.5 : 1,
                }}
              >
                {insightBusy === "review" ? "审查中…" : "✨ AI 审查"}
              </button>
              <button
                onClick={() => void runInsight("commit-message")}
                disabled={insightBusy !== null || files.length === 0}
                title={sessionId ? "调用当前会话的模型生成提交信息" : "需要先选择一个会话提供模型"}
                style={{
                  ...btnStyle("var(--bg-panel)"),
                  flex: 1,
                  color: "var(--accent)",
                  borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))",
                  opacity: insightBusy !== null || files.length === 0 ? 0.5 : 1,
                }}
              >
                {insightBusy === "commit-message" ? "生成中…" : "✨ 生成提交信息"}
              </button>
            </div>
          </div>
        </>
      ) : (
        /* History view: ASCII graph + commit list */
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {logError ? (
            <div style={{ padding: 12, fontSize: 11, color: "#f87171" }}>{logError}</div>
          ) : log === null ? (
            <div style={{ padding: 12, fontSize: 11, color: "var(--text-dim)" }}>加载提交历史…</div>
          ) : log.length === 0 ? (
            <div style={{ padding: 12, fontSize: 11, color: "var(--text-dim)" }}>暂无提交</div>
          ) : (
            log.map((c) => (
              <div
                key={c.hash}
                title={`${c.hash}\n${c.author}`}
                style={{
                  display: "flex", alignItems: "baseline", gap: 8,
                  padding: "3px 10px", fontSize: 11,
                  borderBottom: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: "17px",
                    whiteSpace: "pre", color: "var(--text-dim)", flexShrink: 0, userSelect: "none",
                  }}
                >
                  {c.graph}
                </span>
                {c.refs && (
                  <span style={{ flexShrink: 0, fontSize: 9.5, fontFamily: "var(--font-mono)", color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)", padding: "0 5px", borderRadius: 999, lineHeight: "15px" }}>
                    {c.refs.replace(/HEAD -> /, "")}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                  {c.subject}
                </span>
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>{c.relTime}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function btnStyle(bg: string, color = "var(--text-muted)"): React.CSSProperties {
  return {
    height: 22, padding: "0 8px", border: "1px solid var(--border)",
    borderRadius: 4, background: bg, color,
    fontSize: 11, fontWeight: 500, cursor: "pointer",
    display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap",
    transition: "opacity 0.1s",
  };
}

const miniBtn: React.CSSProperties = {
  height: 18, padding: "0 6px", border: "1px solid var(--border)",
  borderRadius: 3, background: "transparent", color: "var(--text-dim)",
  fontSize: 9, cursor: "pointer", whiteSpace: "nowrap",
};
