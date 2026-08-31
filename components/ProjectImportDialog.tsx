"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * 项目导入 — 上传配置包（zip），服务端校验后解包合并进项目 home。
 *
 * 包内容：.pi/ 配置目录（agents · extensions · skills · models.json…，凭证
 * 会被自动剥离）+ labs/ 实验手册。同名文件覆盖、其余保留 —— 与「复制为新
 * 项目」同语义，来源是上传的压缩包而已。
 */
interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
  /** 导入成功后通知属主刷新项目数据。 */
  onImported?: () => void;
}

interface ImportResult {
  added: number;
  overwritten: number;
  files: string[];
}

export function ProjectImportDialog({ projectId, projectName, onClose, onImported }: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const pickFile = (f: File | null) => {
    setError(null);
    setResult(null);
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      setError(t("仅支持 .zip 配置包"));
      return;
    }
    if (f.size > 30 * 1024 * 1024) {
      setError(t("配置包过大（>30MB）"));
      return;
    }
    setFile(f);
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/config-import`, {
        method: "POST",
        body,
      });
      const data = (await res.json()) as Partial<ImportResult> & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult({ added: data.added ?? 0, overwritten: data.overwritten ?? 0, files: data.files ?? [] });
      onImported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(520px, 92vw)", display: "flex", flexDirection: "column", gap: 14,
          padding: "20px 22px", borderRadius: 12,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            {t("导入项目配置")} <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)" }}>— {projectName}</span>
          </span>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>

        {!result && (
          <>
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
              style={{
                border: `1px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 8, padding: file ? "18px 16px" : "26px 16px",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                color: dragOver ? "var(--accent)" : "var(--text-dim)", fontSize: 12, textAlign: "center",
                cursor: "pointer", background: dragOver ? "var(--bg-hover)" : "transparent",
                transition: "border-color 0.12s, background 0.12s",
              }}
            >
              <span style={{ fontSize: 22 }}>📦</span>
              {file ? (
                <>
                  <span style={{ color: "var(--text)", fontSize: 13 }}>{file.name}</span>
                  <span style={{ fontSize: 11 }}>{(file.size / 1024).toFixed(1)} KB</span>
                </>
              ) : (
                <span>{t("点击选择或拖入 .zip 配置包")}</span>
              )}
              <span style={{ fontSize: 11 }}>
                {t("支持内容：.pi/ 配置（子智能体 · skills · 插件 · 模型配置）+ labs/ 实验手册")}<br />
                {t("同名文件覆盖，其余保留；凭证（auth.json）会被自动剥离")}
              </span>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: "none" }}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />

            {error && <div style={{ fontSize: 12, color: "#ef4444" }}>{error}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  height: 30, padding: "0 16px", borderRadius: 6,
                  border: "1px solid var(--border)", background: "transparent",
                  color: "var(--text)", fontSize: 12, cursor: "pointer",
                }}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={upload}
                disabled={!file || busy}
                style={{
                  height: 30, padding: "0 18px", borderRadius: 6,
                  border: "none", background: "var(--accent)", color: "#fff",
                  fontSize: 12, fontWeight: 500, cursor: !file || busy ? "default" : "pointer",
                  opacity: !file || busy ? 0.5 : 1,
                }}
              >
                {busy ? t("导入中…") : t("导入")}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#22c55e", fontSize: 13 }}>
              ✓ {t("导入完成")}
            </div>
            <div style={{ fontSize: 12, color: "var(--text)" }}>
              {t("新增 {n} 个文件，覆盖 {m} 个文件", { n: String(result.added), m: String(result.overwritten) })}
            </div>
            <div
              style={{
                maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6,
                padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: 11,
                color: "var(--text-muted)", background: "var(--bg)",
              }}
            >
              {result.files.map((f) => <div key={f}>{f}</div>)}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("重新打开该项目会话后新配置生效（子智能体 / skills 即时可用）。")}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  height: 30, padding: "0 18px", borderRadius: 6,
                  border: "none", background: "var(--accent)", color: "#fff",
                  fontSize: 12, fontWeight: 500, cursor: "pointer",
                }}
              >
                {t("完成")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
