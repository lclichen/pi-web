"use client";

/**
 * 本机目录可视化选择器 — 通过 relay 的 fs.list RPC 浏览已配对 Agent 的文件
 * 系统（agent 将 fs.* 限制在其共享工作区内）。供「连接本地」向导第 ④ 步
 * 选择远程工作目录使用。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useRelayAgent } from "@/hooks/useRelayAgent";

interface Entry {
  name: string;
  path: string; // workspace-relative
  isDir: boolean;
}

interface Props {
  /** 选择目录后回调（绝对路径 = workspaceRoot + "/" + rel）。 */
  onPick: (absPath: string) => void;
  onClose: () => void;
}

function joinAbs(root: string, rel: string): string {
  if (!rel) return root;
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

export function LocalDirectoryPicker({ onPick, onClose }: Props) {
  const { t } = useI18n();
  const { info, online } = useRelayAgent();
  const root = info?.workspaceRoot ?? "";
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-relay/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "fs.list", params: { path } }),
      });
      const d = (await res.json()) as { success?: boolean; data?: Entry[]; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setEntries((d.data ?? []).filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (root) void load(rel);
  }, [root, rel, load]);

  const selectedAbs = joinAbs(root, rel);

  if (!online) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>
        {t("本机 Agent 未连接，无法浏览目录")}
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* 面包屑 */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", flexWrap: "wrap" }}>
        <button type="button" onClick={() => setRel("")} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>
          {root}
        </button>
        {rel.split("/").filter(Boolean).map((seg, i, arr) => (
          <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <span>/</span>
            <button
              type="button"
              onClick={() => setRel(arr.slice(0, i + 1).join("/"))}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* 目录列表 */}
      <div style={{ maxHeight: 260, overflowY: "auto", minHeight: 120 }}>
        {loading ? (
          <div style={{ padding: 12, fontSize: 12, color: "var(--text-dim)" }}>{t("i18n.loading")}</div>
        ) : error ? (
          <div style={{ padding: 12, fontSize: 12, color: "#ef4444" }}>{error}</div>
        ) : (
          <>
            {rel && (
              <button
                type="button"
                onClick={() => setRel(rel.split("/").slice(0, -1).join("/"))}
                style={{ display: "flex", gap: 8, width: "100%", padding: "5px 10px", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--text-muted)", textAlign: "left" }}
              >
                ..
              </button>
            )}
            {entries.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => setRel(e.path)}
                style={{ display: "flex", gap: 8, width: "100%", padding: "5px 10px", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--text)", textAlign: "left" }}
              >
                <span style={{ color: "var(--accent)" }}>▸</span> {e.name}
              </button>
            ))}
            {entries.length === 0 && !loading && (
              <div style={{ padding: 12, fontSize: 11, color: "var(--text-dim)" }}>{t("（空目录）")}</div>
            )}
          </>
        )}
      </div>

      {/* 底部：当前选择 + 确认 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
        <code style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={selectedAbs}>
          {selectedAbs}
        </code>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button type="button" onClick={onClose} style={{ height: 28, padding: "0 12px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer" }}>
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={() => onPick(selectedAbs)}
            style={{ height: 28, padding: "0 14px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, cursor: "pointer" }}
          >
            {t("选择此目录")}
          </button>
        </div>
      </div>
    </div>
  );
}
