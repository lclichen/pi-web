"use client";

/**
 * SSH 远程目录可视化选择器 — 用向导第 ② 步填写的连接配置调用
 * /api/host/ssh-list（一次性连接，不落盘、不入池）浏览远程主机目录。
 * 初始路径为远端账号的 home；供「SSH 连接」向导第 ④ 步选择远程工作目录。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface SshPickerConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

interface Props {
  config: SshPickerConfig;
  onPick: (absPath: string) => void;
  onClose: () => void;
}

function parentOf(path: string): string {
  const p = path.replace(/\/+$/, "");
  if (!p || p === "/") return "";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

export function SshDirectoryPicker({ config, onPick, onClose }: Props) {
  const { t } = useI18n();
  const [path, setPath] = useState<string | null>(null); // null = 未加载（首帧解析 home）
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string | undefined) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/host/ssh-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, ...(target ? { path: target } : {}) }),
      });
      const d = (await res.json()) as { path?: string; entries?: Entry[]; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setPath(d.path ?? "/");
      setEntries((d.entries ?? []).filter((e) => e.isDir));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void load(undefined);
  }, [load]);

  const crumbs = (path ?? "").split("/").filter(Boolean);
  const selected = path ?? "";

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* 面包屑 */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void load("/")} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>
          /
        </button>
        {crumbs.map((seg, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => void load("/" + crumbs.slice(0, i + 1).join("/"))}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}
            >
              {seg}
            </button>
            {i < crumbs.length - 1 && <span>/</span>}
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
            {selected !== "/" && (
              <button
                type="button"
                onClick={() => void load(parentOf(selected) || "/")}
                style={{ display: "flex", gap: 8, width: "100%", padding: "5px 10px", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--text-muted)", textAlign: "left" }}
              >
                ..
              </button>
            )}
            {entries.map((e) => (
              <button
                key={e.name}
                type="button"
                onClick={() => void load(`${selected.replace(/\/+$/, "")}/${e.name}`)}
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
        <code style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={selected}>
          {selected || "…"}
        </code>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button type="button" onClick={onClose} style={{ height: 28, padding: "0 12px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer" }}>
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={!selected || selected === "/"}
            onClick={() => onPick(selected)}
            title={selected === "/" ? t("请选择 / 以外的目录") : undefined}
            style={{ height: 28, padding: "0 14px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, cursor: selected && selected !== "/" ? "pointer" : "not-allowed", opacity: selected && selected !== "/" ? 1 : 0.5 }}
          >
            {t("选择此目录")}
          </button>
        </div>
      </div>
    </div>
  );
}
