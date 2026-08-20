"use client";

/**
 * 项目导入 — 预留入口（教学场景：连接沙箱/本机后一键配置项目）。
 *
 * 规划能力：上传配置包（zip 或实验手册 YAML，内含 .pi/ 目录结构 —— 插件、
 * 子智能体、skills、labs、可选的 models.json/auth.json），服务端校验后解包
 * 合并进项目 home，实现"一键初始化项目"。当前仅预留入口与交互骨架，
 * 上传与解包逻辑开发中。
 */
interface Props {
  projectName: string;
  onClose: () => void;
}

export function ProjectImportDialog({ projectName, onClose }: Props) {
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
          width: "min(480px, 92vw)", display: "flex", flexDirection: "column", gap: 14,
          padding: "20px 22px", borderRadius: 12,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
            导入项目配置 <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)" }}>— {projectName}</span>
          </span>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>

        <div
          style={{
            border: "1px dashed var(--border)", borderRadius: 8, padding: "26px 16px",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
            color: "var(--text-dim)", fontSize: 12, textAlign: "center",
          }}
        >
          <span style={{ fontSize: 22 }}>📦</span>
          <span>连接沙箱 / 本机后，上传配置包一键初始化项目</span>
          <span style={{ fontSize: 11 }}>
            支持内容（规划）：.pi/ 配置目录（插件 · 子智能体 · skills）<br />
            实验手册 labs YAML · 可选的项目级模型凭证
          </span>
        </div>

        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          该功能开发中，当前为预留入口。现有替代：项目菜单「复制为新项目」可从既有项目快照一套配置。
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 30, padding: "0 16px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text)", fontSize: 12, cursor: "pointer",
            }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
