"use client";

import { useCallback, useEffect, useState } from "react";
import type { GitFileStatus, GitStatusResponse } from "@/lib/git-types";

interface BranchInfo {
  current: string | null;
  ahead: number;
  behind: number;
  tracking: string | null;
}

interface Props {
  cwd: string;
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

export function GitPanel({ cwd, refreshKey, onClose }: Props) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

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

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

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
      {/* Header: branch + remote ops */}
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
        <div style={{ flex: 1 }} />
        <button onClick={handleFetch} disabled={!!busy} title="Fetch all remotes" style={btnStyle("var(--bg-panel)")}>
          {busy === "fetch" ? "..." : "Fetch"}
        </button>
        <button onClick={handlePull} disabled={!!busy} title="Pull from remote" style={btnStyle("var(--bg-panel)")}>
          {busy === "pull" ? "..." : "Pull"}
        </button>
        <button onClick={handlePush} disabled={!!busy} title="Push to remote" style={btnStyle("var(--accent)", "#fff")}>
          {busy === "push" ? "..." : "Push"}
        </button>
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
      </div>
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
