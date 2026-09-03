"use client";

/**
 * 设置 → 用户：当前账号信息 + 修改密码。
 *
 * 账号的唯一事实源是沙盒平台（pi-web 登录即平台登录），本组件经
 * /api/account 代理读取 /api/v1/auth/me、提交 /api/v1/auth/change-password；
 * 平台校验当前密码与密码策略，并吊销该用户全部刷新令牌（pi-web 会话
 * 基于平台 API Key，不受影响，无需重新登录）。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface AccountUser {
  id: number;
  username: string;
  email: string | null;
  role: string;
  status?: string;
  mustChangePassword?: boolean;
}

interface Props {
  /** 关闭设置面板（保存成功后由用户手动关闭，此处仅用于可选的关闭按钮） */
  onClose?: () => void;
}

export function AccountSettings({ onClose }: Props) {
  const { t } = useI18n();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/account")
      .then(async (res) => {
        const d = (await res.json().catch(() => ({}))) as {
          authEnabled?: boolean; user?: AccountUser; error?: string;
        };
        if (cancelled) return;
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        setAuthEnabled(d.authEnabled !== false);
        if (d.user) setUser(d.user);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, []);

  const submit = useCallback(async () => {
    setMessage(null);
    if (!newPassword || newPassword !== confirmPassword) {
      setMessage({ ok: false, text: t("account.passwordMismatch") });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: t("account.success") });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newPassword, confirmPassword, t]);

  if (loadError) {
    return (
      <div className="settings-general">
        <h2 className="settings-general-title">{t("settings.account")}</h2>
        <p role="alert" className="settings-general-error">{loadError}</p>
        {onClose && (
          <button type="button" className="config-close-button" onClick={onClose} aria-label={t("i18n.close")}>×</button>
        )}
      </div>
    );
  }

  if (authEnabled === false) {
    return (
      <div className="settings-general">
        <h2 className="settings-general-title">{t("settings.account")}</h2>
        <section className="settings-general-section">
          <p className="settings-general-description">{t("account.authDisabled")}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.account")}</h2>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("account.infoHeading")}</h3>
        <p className="settings-general-description">{t("account.description")}</p>
        <dl className="account-info-list">
          <div className="account-info-row">
            <dt>{t("account.username")}</dt>
            <dd>{user?.username ?? "…"}</dd>
          </div>
          <div className="account-info-row">
            <dt>{t("account.role")}</dt>
            <dd>{user?.role === "admin" ? t("account.role.admin") : t("account.role.user")}</dd>
          </div>
          {user?.email ? (
            <div className="account-info-row">
              <dt>{t("account.email")}</dt>
              <dd>{user.email}</dd>
            </div>
          ) : null}
          {user?.mustChangePassword ? (
            <div className="account-info-row">
              <dt>{t("account.status")}</dt>
              <dd className="account-warn">{t("account.statusMustChange")}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("account.changeHeading")}</h3>
        <p className="settings-general-description">{t("account.changeDescription")}</p>
        <form
          className="account-password-form"
          onSubmit={(e) => { e.preventDefault(); if (!busy) void submit(); }}
        >
          <label>
            <span>{t("account.currentPassword")}</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            <span>{t("account.newPassword")}</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
            <small>{t("account.passwordPolicyHint")}</small>
          </label>
          <label>
            <span>{t("account.confirmPassword")}</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          {message && (
            <p role={message.ok ? "status" : "alert"} className={message.ok ? "account-success" : "settings-general-error"}>
              {message.text}
            </p>
          )}
          <button type="submit" className="account-submit" disabled={busy || !currentPassword || !newPassword || !confirmPassword}>
            {busy ? t("account.changing") : t("account.submit")}
          </button>
        </form>
      </section>
    </div>
  );
}
