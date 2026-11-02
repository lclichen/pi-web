"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface PlatformLimits {
  workspaceUploadMaxBytes: number;
  envDefaultBytes: number;
  minBytes: number;
  maxBytes: number;
}

interface GlobalConfigView {
  publicBaseUrl: string | null;
  skillhubUrl: string | null;
  bundleMaxMb: number | null;
  workspace: PlatformLimits | null;
}

interface EffectiveLimits {
  bundleMaxMb: number;
  bundleConfirmMb: number;
}

type ConfigKind = "publicBaseUrl" | "skillhubUrl" | "bundle" | "workspace";

/**
 * 管理员 · 全局配置 — 部署级设置的唯一入口：
 *   · 对外访问地址：share_file / POST /api/share 生成链接时的前缀（留空 = 按
 *     请求 Host 自动推断；跨设备/反向代理场景必须显式配置）。
 *   · SkillHub 默认地址：技能搜索与安装的内网源（留空 = skills.sh 公网流程）。
 *   · 上传限制：配置包硬上限落在 pi-web server-settings（立即生效），工作区
 *     单文件上限由平台执行（写平台 runtime-settings，无需重启）。
 */
export function AdminGlobalConfig() {
  const { t } = useI18n();
  const [view, setView] = useState<GlobalConfigView | null>(null);
  const [effective, setEffective] = useState<EffectiveLimits | null>(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [skillhubUrl, setSkillhubUrl] = useState("");
  const [bundleInput, setBundleInput] = useState("");
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [busy, setBusy] = useState<ConfigKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [adminRes, effRes] = await Promise.all([fetch("/api/admin/global-config"), fetch("/api/upload-limits")]);
      const admin = (await adminRes.json()) as GlobalConfigView & { error?: string };
      if (!adminRes.ok) throw new Error(admin.error ?? `HTTP ${adminRes.status}`);
      setView(admin);
      setPublicBaseUrl(admin.publicBaseUrl ?? "");
      setSkillhubUrl(admin.skillhubUrl ?? "");
      if (effRes.ok) {
        const eff = (await effRes.json()) as EffectiveLimits;
        setEffective(eff);
        setBundleInput(String(admin.bundleMaxMb ?? eff.bundleMaxMb));
      } else if (admin.bundleMaxMb !== null) {
        setBundleInput(String(admin.bundleMaxMb));
      }
      if (admin.workspace) {
        setWorkspaceInput(String(Math.round(admin.workspace.workspaceUploadMaxBytes / 1024 / 1024)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (kind: ConfigKind, patch: Record<string, unknown>) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/global-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setNotice(t("settings.globalConfigSaved"));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const bundleDefault = effective?.bundleMaxMb ?? 2048;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "18px 22px", maxWidth: 760 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("settings.globalConfig")}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.6 }}>
          {t("settings.globalConfigHint")}
        </div>
      </div>

      <section style={cardStyle}>
        <label style={labelStyle}>{t("settings.publicBaseUrl")}</label>
        <div style={hintStyle}>{t("settings.publicBaseUrlHint")}</div>
        <div style={rowStyle}>
          <input
            type="url"
            value={publicBaseUrl}
            placeholder={t("settings.publicBaseUrlPlaceholder")}
            onChange={(e) => setPublicBaseUrl(e.target.value)}
            style={{ ...inputStyle, width: 360, maxWidth: "100%" }}
          />
          <button
            type="button"
            style={primaryBtnStyle}
            disabled={busy !== null}
            onClick={() => void save("publicBaseUrl", { publicBaseUrl: publicBaseUrl.trim() })}
          >
            {t("settings.uploadLimitSave")}
          </button>
          <button
            type="button"
            style={btnStyle}
            disabled={busy !== null}
            onClick={() => void save("publicBaseUrl", { publicBaseUrl: null })}
          >
            {t("settings.uploadLimitReset")}
          </button>
        </div>
        <div style={metaStyle}>
          {view?.publicBaseUrl
            ? t("settings.publicBaseUrlEffective", { value: view.publicBaseUrl })
            : t("settings.publicBaseUrlAuto")}
        </div>
      </section>

      <section style={cardStyle}>
        <label style={labelStyle}>{t("settings.skillhubUrl")}</label>
        <div style={hintStyle}>{t("settings.skillhubUrlHint")}</div>
        <div style={rowStyle}>
          <input
            type="url"
            value={skillhubUrl}
            placeholder={t("settings.skillhubUrlPlaceholder")}
            onChange={(e) => setSkillhubUrl(e.target.value)}
            style={{ ...inputStyle, width: 360, maxWidth: "100%" }}
          />
          <button
            type="button"
            style={primaryBtnStyle}
            disabled={busy !== null}
            onClick={() => void save("skillhubUrl", { skillhubUrl: skillhubUrl.trim() })}
          >
            {t("settings.uploadLimitSave")}
          </button>
          <button
            type="button"
            style={btnStyle}
            disabled={busy !== null}
            onClick={() => void save("skillhubUrl", { skillhubUrl: null })}
          >
            {t("settings.uploadLimitReset")}
          </button>
        </div>
        <div style={metaStyle}>{view?.skillhubUrl ? view.skillhubUrl : t("settings.skillhubUrlDefault")}</div>
      </section>

      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginTop: 6 }}>
        {t("settings.uploadLimits")}
      </div>

      <section style={cardStyle}>
        <label style={labelStyle}>{t("settings.uploadLimitBundle")}</label>
        <div style={rowStyle}>
          <input
            type="number"
            min={1}
            max={65536}
            value={bundleInput}
            onChange={(e) => setBundleInput(e.target.value)}
            style={{ ...inputStyle, width: 140 }}
          />
          <button
            type="button"
            style={primaryBtnStyle}
            disabled={busy !== null || bundleInput.trim() === ""}
            onClick={() => void save("bundle", { bundleMaxMb: Number(bundleInput) })}
          >
            {t("settings.uploadLimitSave")}
          </button>
          <button
            type="button"
            style={btnStyle}
            disabled={busy !== null}
            onClick={() => {
              setBundleInput(String(bundleDefault));
              void save("bundle", { bundleMaxMb: null });
            }}
          >
            {t("settings.uploadLimitReset")}
          </button>
          <span style={metaStyle}>
            {t("settings.uploadLimitDefault", { value: `${bundleDefault} MB` })}
            {effective ? ` · ${t("settings.uploadLimitConfirm", { value: `${effective.bundleConfirmMb} MB` })}` : ""}
          </span>
        </div>
        <div style={hintStyle}>{t("settings.uploadLimitHint")}</div>
      </section>

      <section style={cardStyle}>
        <label style={labelStyle}>{t("settings.uploadLimitWorkspace")}</label>
        {view?.workspace ? (
          <>
            <div style={rowStyle}>
              <input
                type="number"
                min={Math.ceil(view.workspace.minBytes / 1024 / 1024)}
                max={Math.floor(view.workspace.maxBytes / 1024 / 1024)}
                value={workspaceInput}
                onChange={(e) => setWorkspaceInput(e.target.value)}
                style={{ ...inputStyle, width: 140 }}
              />
              <button
                type="button"
                style={primaryBtnStyle}
                disabled={busy !== null || workspaceInput.trim() === ""}
                onClick={() =>
                  void save("workspace", { workspaceMaxBytes: Math.round(Number(workspaceInput) * 1024 * 1024) })
                }
              >
                {t("settings.uploadLimitSave")}
              </button>
              <button
                type="button"
                style={btnStyle}
                disabled={busy !== null}
                onClick={() => void save("workspace", { workspaceMaxBytes: null })}
              >
                {t("settings.uploadLimitReset")}
              </button>
              <span style={metaStyle}>
                {t("settings.uploadLimitDefault", {
                  value: `${Math.round(view.workspace.envDefaultBytes / 1024 / 1024)} MB`,
                })}
              </span>
            </div>
            <div style={metaStyle}>
              {t("settings.uploadLimitEffective", {
                value: `${Math.round(view.workspace.workspaceUploadMaxBytes / 1024 / 1024)} MB`,
              })}
            </div>
          </>
        ) : (
          <div style={{ ...metaStyle, color: "var(--warning, #f59e0b)" }}>{t("settings.uploadLimitUnavailable")}</div>
        )}
      </section>

      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
          {error}
        </div>
      )}
      {notice && <div style={{ fontSize: 12, color: "var(--accent)" }}>{notice}</div>}
    </div>
  );
}

const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column" as const,
  gap: 8,
} as const;

const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--text)" } as const;
const hintStyle = { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 } as const;
const rowStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const } as const;
const metaStyle = { fontSize: 11, color: "var(--text-dim)" } as const;

const inputStyle = {
  height: 30,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
} as const;

const btnStyle = {
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
} as const;

const primaryBtnStyle = {
  ...btnStyle,
  color: "#fff",
  background: "var(--accent)",
  borderColor: "var(--accent)",
} as const;
