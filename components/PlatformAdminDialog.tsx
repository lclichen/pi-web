"use client";

/**
 * PlatformAdminDialog — 站内沙盒平台管理面板（P1：用户管理）。
 *
 * Phase 1 of consolidating the platform's admin SPA into pi-web: admins
 * manage users (list / search / create / reset password / enable-disable /
 * approve-reject / delete) without leaving the WebUI — no second login, no
 * external browser tab (painful under the Electron packaging). All calls go
 * through the /api/admin/users BFF proxy which forwards the admin's platform
 * API key; the platform re-authorizes every call. The full legacy console
 * stays one click away until later batches (containers/images/quotas/LLM)
 * migrate in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface PlatformUserRow {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user" | string;
  status: string;
  must_change_password?: boolean;
  created_at?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Legacy console URL — kept as a fallback link until P2/P3 pages land. */
  consoleUrl?: string | null;
}

const PAGE_SIZE = 20;
const STATUSES = ["", "active", "pending", "disabled", "rejected"];

export function PlatformAdminDialog({ open, onClose, consoleUrl }: Props) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PlatformUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<PlatformUserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (search.trim()) params.set("search", search.trim());
      if (status) params.set("status", status);
      const res = await fetch(`/api/admin/users?${params}`, { credentials: "same-origin" });
      const data = (await res.json()) as { users?: PlatformUserRow[]; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.users ?? []);
      setTotal(data.total ?? 0);
      setOffset(nextOffset);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    if (open) void load(0);
  }, [open, load]);

  // Escape closes (reset sub-dialog first).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (resetFor) setResetFor(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, resetFor, onClose]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const action = async (path: string, init?: RequestInit): Promise<boolean> => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, { credentials: "same-origin", ...init });
      if (!res.ok && res.status !== 204) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const doResetPassword = async () => {
    if (!resetFor || resetPassword.length < 8) return;
    if (await action(`/api/admin/users/${resetFor.id}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: resetPassword }),
    })) {
      setNotice(t("已重置 {name} 的密码，其所有旧会话已失效", { name: resetFor.username }));
      setResetFor(null);
      setResetPassword("");
    }
  };

  const doStatus = async (user: PlatformUserRow, next: string) => {
    if (await action(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    })) {
      setNotice(t("已将 {name} 置为 {status}", { name: user.username, status: next }));
      void load(offset);
    }
  };

  const doDelete = async (user: PlatformUserRow) => {
    if (!window.confirm(t("确定删除用户 {name}？其容器与工作区将一并清理", { name: user.username }))) return;
    if (await action(`/api/admin/users/${user.id}`, { method: "DELETE" })) {
      setNotice(t("已删除 {name}", { name: user.username }));
      void load(offset);
    }
  };

  const doApprove = async (user: PlatformUserRow, act: "approve" | "reject") => {
    if (await action(`/api/admin/users/${user.id}/${act}`, { method: "POST" })) {
      setNotice(act === "approve" ? t("已批准 {name}", { name: user.username }) : t("已拒绝 {name}", { name: user.username }));
      void load(offset);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  const statusChip = useMemo(
    () => (s: string) => ({
      active: { color: "var(--success, #22c55e)" },
      pending: { color: "var(--warning, #eab308)" },
      disabled: { color: "var(--text-dim)" },
      rejected: { color: "var(--text-dim)" },
    })[s] ?? { color: "var(--text-muted)" },
    [],
  );

  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: "min(880px, 94vw)", maxHeight: "88vh", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 13 }}>{t("平台管理")}</strong>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("用户（P1）· 容器/镜像等后续批次迁入")}</span>
          <div style={{ flex: 1 }} />
          {consoleUrl && (
            <a
              href={consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}
              title={t("完整管理台（旧版控制台，功能逐步迁入）")}
            >
              {t("完整控制台 ↗")}
            </a>
          )}
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15 }}>✕</button>
        </div>

        {/* toolbar */}
        <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void load(0); }}
            placeholder={t("搜索用户名/邮箱")}
            style={{ flex: 1, minWidth: 160, padding: "5px 9px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
          />
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); }}
            style={{ padding: "5px 7px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s === "" ? t("全部状态") : s}</option>
            ))}
          </select>
          <button type="button" onClick={() => void load(0)} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}>
            {t("搜索")}
          </button>
          <button type="button" onClick={() => setCreating((v) => !v)} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer" }}>
            {creating ? t("取消") : t("+ 新建用户")}
          </button>
        </div>

        {creating && (
          <CreateUserForm
            onCancel={() => setCreating(false)}
            onCreated={async (name) => { setCreating(false); setNotice(t("已创建用户 {name}", { name })); await load(0); }}
            action={action}
            t={t}
          />
        )}

        {(notice || error) && (
          <div style={{ padding: "6px 16px", fontSize: 11.5, color: error ? "#f87171" : "var(--success, #22c55e)", borderBottom: "1px solid var(--border)" }}>
            {error ?? notice}
          </div>
        )}

        {/* table */}
        <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
                <th style={{ padding: "8px 8px", fontWeight: 500 }}>#</th>
                <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("用户名")}</th>
                <th style={{ padding: "8px 8px", fontWeight: 500 }}>Email</th>
                <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("角色")}</th>
                <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("状态")}</th>
                <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("没有匹配的用户")}</td></tr>
              )}
              {!loading && rows.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{u.id}</td>
                  <td style={{ padding: "7px 8px", fontWeight: 500 }}>
                    {u.username}
                    {u.must_change_password && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--warning, #eab308)" }} title={t("下次登录须改密")}>⟳</span>}
                  </td>
                  <td style={{ padding: "7px 8px", color: "var(--text-muted)" }}>{u.email ?? "—"}</td>
                  <td style={{ padding: "7px 8px" }}>{u.role}</td>
                  <td style={{ padding: "7px 8px", color: statusChip(u.status).color }}>{u.status}</td>
                  <td style={{ padding: "7px 8px", whiteSpace: "nowrap" }}>
                    {u.status === "pending" ? (
                      <>
                        <MiniButton onClick={() => void doApprove(u, "approve")} accent>{t("批准")}</MiniButton>
                        <MiniButton onClick={() => void doApprove(u, "reject")}>{t("拒绝")}</MiniButton>
                      </>
                    ) : (
                      <>
                        <MiniButton onClick={() => setResetFor(u)} accent>{t("重置密码")}</MiniButton>
                        {u.status === "active"
                          ? <MiniButton onClick={() => void doStatus(u, "disabled")}>{t("停用")}</MiniButton>
                          : u.status === "disabled" && <MiniButton onClick={() => void doStatus(u, "active")}>{t("启用")}</MiniButton>}
                        <MiniButton onClick={() => void doDelete(u)} danger>{t("删除")}</MiniButton>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)" }}>
          <span>{t("共 {total} 人", { total: String(total) })}</span>
          <div style={{ flex: 1 }} />
          <button type="button" disabled={page <= 1 || loading} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))} style={{ ...pagerBtn, opacity: page <= 1 ? 0.4 : 1 }}>{t("上一页")}</button>
          <span>{page} / {pages}</span>
          <button type="button" disabled={page >= pages || loading} onClick={() => void load(offset + PAGE_SIZE)} style={{ ...pagerBtn, opacity: page >= pages ? 0.4 : 1 }}>{t("下一页")}</button>
        </div>

        {/* reset-password sub-dialog */}
        {resetFor && (
          <div style={{ position: "absolute", inset: 0, zIndex: 91, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", borderRadius: 10 }}>
            <div style={{ width: 320, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
              <strong style={{ fontSize: 12.5 }}>{t("重置 {name} 的密码", { name: resetFor.username })}</strong>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0" }}>{t("重置后该用户的所有会话与登录态立即失效；请将新密码安全地告知用户（至少 8 字符）。")}</p>
              <input
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doResetPassword(); }}
                placeholder={t("新密码（≥8 字符）")}
                autoFocus
                style={{ width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <MiniButton onClick={() => { setResetFor(null); setResetPassword(""); }}>{t("取消")}</MiniButton>
                <MiniButton accent disabled={resetPassword.length < 8} onClick={() => void doResetPassword()}>{t("确定重置")}</MiniButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const pagerBtn: React.CSSProperties = { padding: "3px 10px", fontSize: 11, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 6, cursor: "pointer" };

function MiniButton({ children, onClick, accent, danger, disabled }: {
  children: React.ReactNode; onClick: () => void; accent?: boolean; danger?: boolean; disabled?: boolean;
}) {
  const color = danger ? "#f87171" : accent ? "var(--accent)" : "var(--text-muted)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ background: "none", border: "none", color, fontSize: 11, cursor: disabled ? "default" : "pointer", padding: "2px 6px", opacity: disabled ? 0.4 : 1 }}
    >
      {children}
    </button>
  );
}

function CreateUserForm({ onCancel, onCreated, action, t }: {
  onCancel: () => void;
  onCreated: (name: string) => void;
  action: (path: string, init?: RequestInit) => Promise<boolean>;
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!username || password.length < 8) return;
    setBusy(true);
    setErr(null);
    const ok = await action("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, ...(email ? { email } : {}) }),
    });
    setBusy(false);
    if (ok) onCreated(username);
    else setErr(t("创建失败（用户名重复或密码不符合策略）"));
  };

  const field = (value: string, set: (v: string) => void, placeholder: string, mono = false) => (
    <input
      value={value}
      onChange={(e) => set(e.target.value)}
      placeholder={placeholder}
      style={{ flex: 1, minWidth: 120, padding: "5px 9px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", ...(mono ? { fontFamily: "var(--font-mono)" } : {}) }}
    />
  );

  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap", alignItems: "center" }}>
      {field(username, setUsername, t("用户名"))}
      {field(password, setPassword, t("初始密码（≥8 字符）"), true)}
      {field(email, setEmail, "Email（可选）")}
      <button type="button" disabled={busy || !username || password.length < 8} onClick={() => void submit()} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer", opacity: busy || !username || password.length < 8 ? 0.4 : 1 }}>
        {t("创建")}
      </button>
      <button type="button" onClick={onCancel} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", color: "var(--text-muted)", background: "none", borderRadius: 6, cursor: "pointer" }}>
        {t("取消")}
      </button>
      {err && <span style={{ fontSize: 11, color: "#f87171" }}>{err}</span>}
    </div>
  );
}
