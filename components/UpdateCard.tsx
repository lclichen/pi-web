"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AppUpdateResponse, UpdateStatusResponse } from "@/lib/api-types";
import { ConfigButton, ConfigSectionTitle } from "./SettingsUi";

/**
 * 版本与更新卡片（设置 → 通用）——展示自有版本体系（version.json）的当前
 * 版本/通道，检查 catalog 更新源，管理员可下载并自动应用（分离 applier 负责
 * 交换与重启，本组件只轮询状态文件）。
 */
export function UpdateCard({ isAdmin }: { isAdmin?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<AppUpdateResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/app-update", { cache: "no-store" });
      const data = await res.json() as AppUpdateResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // 应用期间轮询状态；服务重启时请求开始失败——保留最后已知状态即可。
  // 总超时 10 分钟：服务始终没回来时给出失败提示而不是无限「重启中」。
  const startPolling = useCallback(() => {
    stopPolling();
    const deadline = Date.now() + 10 * 60 * 1000;
    pollRef.current = setInterval(() => {
      if (Date.now() > deadline) {
        stopPolling();
        setStatus((prev) => prev && prev.phase !== "done" && prev.phase !== "failed"
          ? { ...prev, phase: "failed", error: t("update.timedOutWaitingServicesCome") }
          : prev);
        return;
      }
      void fetch("/api/app-update/status", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<UpdateStatusResponse>) : null))
        .then((d) => { if (d) setStatus(d); })
        .catch(() => { /* 重启窗口期网络错误忽略 */ });
    }, 1500);
  }, [stopPolling, t]);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (status && (status.phase === "done" || status.phase === "failed")) {
      stopPolling();
      setApplying(false);
    }
  }, [status, stopPolling]);

  const apply = useCallback(async () => {
    setApplying(true);
    setError(null);
    setStatus({ phase: "downloading", message: t("update.submitted") });
    try {
      const res = await fetch("/api/app-update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state?.target ? { version: state.target.version } : {}),
      });
      const data = await res.json() as { started?: boolean; error?: string };
      if (!res.ok || !data.started) throw new Error(data.error ?? `HTTP ${res.status}`);
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
      setApplying(false);
    }
  }, [state, startPolling, t]);

  const busy = applying && status && !["done", "failed"].includes(status.phase);
  const phaseText: Record<string, string> = {
    downloading: t("update.downloading"),
    verifying: t("update.verifying"),
    staging: t("update.extracting"),
    swapping: t("update.swapping"),
    restarting: t("update.restarting"),
  };

  const formatSize = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

  return (
    <div>
      <ConfigSectionTitle>{t("update.versionUpdates")}</ConfigSectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {state?.currentVersion ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "-"}
          </span>
          {state?.channel && <span className="config-scope-tag is-project">{state.channel}</span>}
          <div style={{ flex: 1 }} />
          <ConfigButton size="small" onClick={() => void check()} disabled={checking || Boolean(busy)}>
            {checking ? t("update.checking") : t("update.checkUpdates")}
          </ConfigButton>
        </div>

        {error && <div role="alert" style={{ fontSize: 11, color: "#f87171" }}>{error}</div>}

        {state?.source === "catalog" && state.updateAvailable && state.target && (
          <div style={{ border: "1px solid rgba(37,99,235,0.35)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              {t("update.updateAvailable")} <span style={{ fontFamily: "var(--font-mono)" }}>{state.target.version}</span>
              {state.target.releasedAt && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>{state.target.releasedAt.slice(0, 10)}</span>}
            </div>
            {state.target.frameworks.map((fw) => (
              <div key={fw.kind} style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {fw.kind} · {fw.fileName} · {formatSize(fw.sizeBytes)}
              </div>
            ))}
            {state.canSelfUpdate ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <ConfigButton variant="primary" size="small" onClick={() => void apply()} disabled={Boolean(busy)}>
                  {busy ? (phaseText[status?.phase ?? ""] ?? t("update.working")) : t("update.downloadInstall")}
                </ConfigButton>
                {busy && status?.phase === "downloading" && typeof status.progress === "number" && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {Math.round(status.progress * 100)}%
                  </span>
                )}
                {busy && status?.message && status.phase !== "downloading" && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{status.message}</span>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {t("update.selfUpdateAvailableDeploymentDev")}
              </div>
            )}
            {isAdmin === false && state.canSelfUpdate && (
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("update.adminRightsRequired")}</div>
            )}
          </div>
        )}

        {state?.source === "catalog" && !state.updateAvailable && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("update.upDate")}</div>
        )}

        {status?.phase === "done" && (
          <div style={{ fontSize: 11, color: "#22c55e" }}>{status.message ?? t("update.updateCompleted")}</div>
        )}
        {status?.phase === "failed" && (
          <div role="alert" style={{ fontSize: 11, color: "#f87171" }}>{status.error ?? t("update.updateFailed")}</div>
        )}
        {status?.phase === "restarting" && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("update.restartingReconnect")}</div>
        )}
      </div>
    </div>
  );
}
