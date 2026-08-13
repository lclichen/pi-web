"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentInfo, FsEntry } from "@/lib/relay/protocol";
import { relayFs, relayExec } from "@/lib/relay-client";

interface Props {
  info: AgentInfo;
  onClose: () => void;
}

// End-to-end proof panel: browse the agent's workspace, read/edit/save a file,
// and run a command. Deliberately self-contained (Phase 2 integrates this into
// the main FileExplorer / agent backend).
export function LocalMachinePanel({ info, onClose }: Props) {
  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // selected file editor
  const [file, setFile] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // command runner
  const [cmd, setCmd] = useState("");
  const [result, setResult] = useState<{ exitCode: number; stdout: string; stderr: string } | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await relayFs.list(p || ".");
      setEntries(list);
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

  const openEntry = async (e: FsEntry) => {
    if (e.isDir) {
      setFile(null);
      await refresh(e.path);
      return;
    }
    try {
      const r = await relayFs.read(e.path);
      setFile({ path: e.path, content: r.content, dirty: false });
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
      const abs = path ? `${path}/${name}` : name;
      await relayFs.mkdir(abs);
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
      const r = await relayExec(argv, path || ".", 60);
      setResult(r);
    } catch (err) {
      setResult({ exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 1100, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(1080px, 94vw)", height: "min(82vh, 760px)",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "0 12px 36px rgba(0,0,0,0.3)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>本地机器</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {info.hostname} · {info.os}/{info.arch}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>|</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {info.workspaceRoot}
          </span>
          <button onClick={onClose} style={btnStyle}>关闭</button>
        </div>

        {/* toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
          <button onClick={goParent} disabled={!path} style={btnStyle}>↑ 上级</button>
          <button onClick={newFolder} style={btnStyle}>＋ 新建文件夹</button>
          <button onClick={() => refresh(path)} style={btnStyle}>↻ 刷新</button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            /{path || ""}
          </span>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* file list */}
          <div style={{ width: 280, borderRight: "1px solid var(--border)", overflow: "auto" }}>
            {loading && <div style={muted}>加载中…</div>}
            {error && <div style={{ ...muted, color: "#ef4444" }}>{error}</div>}
            {!loading && entries.length === 0 && !error && <div style={muted}>（空）</div>}
            {entries.map((e) => (
              <button
                key={e.path}
                onClick={() => void openEntry(e)}
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 8,
                  padding: "5px 12px", background: "transparent", border: "none",
                  cursor: "pointer", textAlign: "left", color: "var(--text)",
                  fontFamily: "var(--font-mono)", fontSize: 12,
                }}
              >
                <span>{e.isDir ? "📁" : "📄"}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.name}
                </span>
              </button>
            ))}
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
                    <button onClick={() => void save()} disabled={saving || !file.dirty} style={btnStyle}>
                      {saving ? "保存中…" : "保存"}
                    </button>
                  </div>
                  <textarea
                    value={file.content}
                    onChange={(e) => setFile((f) => (f ? { ...f, content: e.target.value, dirty: true } : f))}
                    spellCheck={false}
                    style={{
                      flex: 1, width: "100%", resize: "none", border: "none", outline: "none",
                      padding: 12, background: "transparent", color: "var(--text)",
                      fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5,
                    }}
                  />
                </>
              ) : (
                <div style={{ ...muted, padding: 24 }}>选择左侧文件查看 / 编辑，或在下方运行命令。</div>
              )}
            </div>

            {/* command runner */}
            <div style={{ borderTop: "1px solid var(--border)", padding: "8px 12px" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
                  placeholder="运行命令（如 ls -la / git status / cat README.md），按回车执行"
                  spellCheck={false}
                  style={{
                    flex: 1, padding: "6px 8px", background: "var(--bg)", color: "var(--text)",
                    border: "1px solid var(--border)", borderRadius: 4,
                    fontFamily: "var(--font-mono)", fontSize: 12,
                  }}
                />
                <button onClick={() => void run()} disabled={running || !cmd.trim()} style={btnStyle}>
                  {running ? "运行中…" : "运行"}
                </button>
              </div>
              {result && (
                <pre style={{
                  margin: "8px 0 0", padding: 8, maxHeight: 160, overflow: "auto",
                  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4,
                  fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap",
                }}>
                  <span style={{ color: result.exitCode === 0 ? "#22c55e" : "#ef4444" }}>
                    [exit {result.exitCode}]
                  </span>
                  {"\n"}
                  {result.stdout}
                  {result.stderr && `${result.stdout ? "\n" : ""}${result.stderr}`}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  cursor: "pointer",
};

const muted: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
};

/** Minimal whitespace/quote tokenizer → argv. No shell, no expansion. */
function parseArgv(cmd: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}
