"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentInfo, FsEntry, GrepMatch } from "@/lib/relay/protocol";
import { relayFs, relayExec, relaySearch } from "@/lib/relay-client";

interface Props {
  info: AgentInfo;
  onClose: () => void;
}

// End-to-end panel: browse the agent's workspace, read/edit/save a file, run a
// command, and search contents (grep) or file names (fd). Deliberately
// self-contained; Phase 2d will integrate this into the main FileExplorer.
export function LocalMachinePanel({ info, onClose }: Props) {
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [file, setFile] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const [cmd, setCmd] = useState("");
  const [result, setResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);
  const [running, setRunning] = useState(false);

  // search state
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"grep" | "fd">("grep");
  const [grepResults, setGrepResults] = useState<GrepMatch[] | null>(null);
  const [fdResults, setFdResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await relayFs.list(p || "."));
      setPath(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh("");
  }, [refresh]);

  const clearSearch = () => {
    setGrepResults(null);
    setFdResults(null);
  };

  const runSearch = async () => {
    if (!q.trim()) {
      clearSearch();
      return;
    }
    setSearching(true);
    setError(null);
    try {
      if (mode === "grep") {
        setFdResults(null);
        setGrepResults(await relaySearch.grep(q, { path: path || ".", maxResults: 200 }));
      } else {
        setGrepResults(null);
        setFdResults(await relaySearch.fd(q, { path: path || ".", maxResults: 500 }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const openPath = async (rel: string) => {
    try {
      const st = await relayFs.stat(rel);
      if (!st.exists) {
        setError("路径不存在");
        return;
      }
      if (st.isDir) {
        setFile(null);
        clearSearch();
        await refresh(rel);
      } else {
        const r = await relayFs.read(rel);
        setFile({ path: rel, content: r.content, dirty: false });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const goParent = () => {
    if (!path) return;
    const idx = path.lastIndexOf("/");
    setFile(null);
    void refresh(idx >= 0 ? path.slice(0, idx) : "");
  };

  const save = async () => {
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      await relayFs.write(file.path, file.content);
      setFile((f) => (f ? { ...f, dirty: false } : f));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const newFolder = async () => {
    const name = window.prompt("新建文件夹名称（相对当前目录）");
    if (!name) return;
    try {
      await relayFs.mkdir(path ? `${path}/${name}` : name);
      await refresh(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (e: FsEntry | string) => {
    const rel = typeof e === "string" ? e : e.path;
    const name = typeof e === "string" ? e : e.name;
    if (!window.confirm(`删除 ${name}?`)) return;
    try {
      await relayFs.delete(rel);
      if (file?.path === rel) setFile(null);
      if (grepResults) setGrepResults((r) => (r ? r.filter((m) => m.file !== rel) : r));
      if (fdResults) setFdResults((r) => (r ? r.filter((p) => p !== rel) : r));
      await refresh(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rename = async (e: FsEntry) => {
    const next = window.prompt(`重命名 ${e.name}`, e.name);
    if (!next || next === e.name) return;
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    try {
      await relayFs.rename(e.path, dir ? `${dir}/${next}` : next);
      await refresh(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async () => {
    const argv = parseArgv(cmd.trim());
    if (argv.length === 0) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await relayExec(argv, path || ".", 60));
    } catch (err) {
      setResult({ exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  const showingSearch = grepResults !== null || fdResults !== null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }}
    >
      <div role="dialog" aria-modal="true" style={{ width: "min(1080px, 94vw)", height: "min(82vh, 760px)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 12px 36px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>本地机器</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{info.hostname} · {info.os}/{info.arch}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>|</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{info.workspaceRoot}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btnStyle}>关闭</button>
        </div>

        {/* toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
          <button onClick={goParent} disabled={!path} style={btnStyle}>↑ 上级</button>
          <button onClick={newFolder} style={btnStyle}>＋ 新建文件夹</button>
          <button onClick={() => refresh(path)} style={btnStyle}>↻ 刷新</button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>/{path || ""}</span>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* left: search + file list */}
          <div style={{ width: 340, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* search row */}
            <div style={{ display: "flex", gap: 4, padding: 6, borderBottom: "1px solid var(--border)" }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
                placeholder={mode === "grep" ? "搜索文件内容 (grep)…" : "搜索文件名 (fd)…"}
                spellCheck={false}
                style={{ flex: 1, padding: "4px 6px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 11 }}
              />
              <button onClick={() => { setMode("grep"); if (q.trim()) void runSearch(); }} style={{ ...btnStyle, fontWeight: mode === "grep" ? 700 : 400, color: mode === "grep" ? "var(--accent)" : "var(--text-muted)" }}>内容</button>
              <button onClick={() => { setMode("fd"); if (q.trim()) void runSearch(); }} style={{ ...btnStyle, fontWeight: mode === "fd" ? 700 : 400, color: mode === "fd" ? "var(--accent)" : "var(--text-muted)" }}>文件名</button>
              {showingSearch && <button onClick={clearSearch} style={btnStyle} title="返回文件列表">×</button>}
            </div>

            {/* list / results */}
            <div style={{ flex: 1, overflow: "auto" }}>
              {loading && <div style={muted}>加载中…</div>}
              {searching && <div style={muted}>搜索中…</div>}
              {error && <div style={{ ...muted, color: "#ef4444", padding: "4px 12px" }}>{error}</div>}

              {showingSearch ? (
                grepResults !== null ? (
                  grepResults.length === 0 ? <div style={muted}>（无匹配）</div> :
                  grepResults.map((m, i) => (
                    <div key={i} style={{ padding: "3px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 6, fontSize: 11, fontFamily: "var(--font-mono)" }}>
                      <button onClick={() => void openPath(m.file)} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", flex: 1, minWidth: 0, color: "var(--text)" }}>
                        <span style={{ color: "var(--accent)" }}>{m.file}:{m.line}</span>
                        <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.text.trim()}</div>
                      </button>
                      <button onClick={() => void remove(m.file)} style={{ ...btnStyle, padding: "0 4px" }}>×</button>
                    </div>
                  ))
                ) : (
                  (fdResults ?? []).length === 0 ? <div style={muted}>（无匹配）</div> :
                  (fdResults ?? []).map((p) => (
                    <div key={p} style={{ padding: "3px 12px", display: "flex", gap: 6, fontSize: 11, fontFamily: "var(--font-mono)" }}>
                      <button onClick={() => void openPath(p)} style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", flex: 1, minWidth: 0, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p}</button>
                      <button onClick={() => void remove(p)} style={{ ...btnStyle, padding: "0 4px" }}>×</button>
                    </div>
                  ))
                )
              ) : (
                !loading && entries.length === 0 && !error ? <div style={muted}>（空）</div> :
                entries.map((e) => (
                  <div key={e.path} style={{ display: "flex", alignItems: "center", padding: "0 12px" }}>
                    <button onClick={() => void openPath(e.path)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, padding: "5px 0", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      <span>{e.isDir ? "📁" : "📄"}</span>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                    </button>
                    <button onClick={() => void rename(e)} title="重命名" style={{ ...btnStyle, padding: "0 4px", opacity: 0.6 }}>✎</button>
                    <button onClick={() => void remove(e)} title="删除" style={{ ...btnStyle, padding: "0 4px", opacity: 0.6 }}>×</button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* right: editor + command */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              {file ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{file.path}</span>
                    {file.dirty && <span style={{ fontSize: 11, color: "#f59e0b" }}>● 未保存</span>}
                    <span style={{ flex: 1 }} />
                    <button onClick={() => void save()} disabled={saving || !file.dirty} style={btnStyle}>{saving ? "保存中…" : "保存"}</button>
                  </div>
                  <textarea
                    value={file.content}
                    onChange={(e) => setFile((f) => (f ? { ...f, content: e.target.value, dirty: true } : f))}
                    spellCheck={false}
                    style={{ flex: 1, width: "100%", resize: "none", border: "none", outline: "none", padding: 12, background: "transparent", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5 }}
                  />
                </>
              ) : (
                <div style={{ ...muted, padding: 24 }}>选择左侧文件查看 / 编辑，或在下方运行命令。可用上方搜索框 grep 内容或 fd 文件名。</div>
              )}
            </div>

            <div style={{ borderTop: "1px solid var(--border)", padding: "8px 12px" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
                  placeholder="运行命令（如 ls -la / git status / pytest -q），回车执行"
                  spellCheck={false}
                  style={{ flex: 1, padding: "6px 8px", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 12 }}
                />
                <button onClick={() => void run()} disabled={running || !cmd.trim()} style={btnStyle}>{running ? "运行中…" : "运行"}</button>
              </div>
              {result && (
                <pre style={{ margin: "8px 0 0", padding: 8, maxHeight: 160, overflow: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
                  <span style={{ color: result.exitCode === 0 ? "#22c55e" : "#ef4444" }}>[exit {result.exitCode}]</span>{"\n"}{result.stdout}{result.stderr && `${result.stdout ? "\n" : ""}${result.stderr}`}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = { padding: "4px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" };
const muted: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", padding: "4px 12px" };

/** Minimal whitespace/quote tokenizer → argv. No shell, no expansion. */
function parseArgv(cmd: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
