"use client";

/**
 * PlatformAdminDialog — 站内沙盒平台管理面板（P1: 用户；P2: 容器/镜像）。
 *
 * Consolidates the platform's admin SPA into pi-web. All calls go through
 * the /api/admin/* BFF proxy which forwards the admin's platform API key; the
 * platform re-authorizes every call. The full legacy console stays one click
 * away until later batches (dashboard/logs/quotas/LLM) migrate in.
 */
import { useCallback, useEffect, useState } from "react";
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

export interface PlatformContainerRow {
  id: number;
  name: string;
  owner_username?: string | null;
  image_id: number;
  status: string;
  cpu: number;
  memory_mb: number;
  disk_gb: number;
  instance_name?: string | null;
  error_message?: string | null;
  updated_at?: string;
}

export interface PlatformImageRow {
  id: number;
  name: string;
  display_name: string;
  sif_path: string;
  description: string | null;
  is_public: boolean | number;
  overlay_kind?: string;
  max_per_user?: number | null;
  created_at?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Legacy console URL — kept as a fallback link until P3 pages land. */
  consoleUrl?: string | null;
}

type Tab = "overview" | "users" | "containers" | "images" | "quotas" | "workspaces" | "llm" | "logs";
type ActionFn = (path: string, init?: RequestInit) => Promise<boolean>;

export function PlatformAdminDialog({ open, onClose, consoleUrl }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const action: ActionFn = async (path, init) => {
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

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: "min(960px, 94vw)", maxHeight: "88vh", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
        }}
      >
        {/* header + tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 16px 0", borderBottom: "1px solid var(--border)" }}>
          {(["overview", "users", "containers", "images", "quotas", "workspaces", "llm", "logs"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setTab(key); setError(null); setNotice(null); }}
              style={{
                padding: "7px 14px 9px", fontSize: 12.5, cursor: "pointer",
                background: "none", border: "none", borderBottom: `2px solid ${tab === key ? "var(--accent)" : "transparent"}`,
                color: tab === key ? "var(--text)" : "var(--text-muted)", fontWeight: tab === key ? 600 : 400,
              }}
            >
              {key === "overview" ? t("概览") : key === "users" ? t("用户") : key === "containers" ? t("容器") : key === "images" ? t("镜像") : key === "quotas" ? t("配额") : key === "workspaces" ? t("工作区") : key === "llm" ? "LLM" : t("日志")}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {consoleUrl && (
            <a
              href={consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none", paddingBottom: 8 }}
              title={t("完整管理台（旧版控制台，功能逐步迁入）")}
            >
              {t("完整控制台 ↗")}
            </a>
          )}
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, paddingBottom: 6 }}>✕</button>
        </div>

        {(notice || error) && (
          <div style={{ padding: "6px 16px", fontSize: 11.5, color: error ? "#f87171" : "var(--success, #22c55e)", borderBottom: "1px solid var(--border)" }}>
            {error ?? notice}
          </div>
        )}

        {tab === "overview" && <OverviewTab notify={(n) => setNotice(n)} />}
        {tab === "users" && <UsersTab action={action} notify={(n) => setNotice(n)} />}
        {tab === "containers" && <ContainersTab action={action} notify={(n) => setNotice(n)} />}
        {tab === "images" && <ImagesTab action={action} notify={(n) => setNotice(n)} />}
        {tab === "quotas" && <QuotasTab action={action} notify={(n) => setNotice(n)} />}
        {tab === "workspaces" && <WorkspacesTab action={action} notify={(n) => setNotice(n)} />}
        {tab === "llm" && <LlmTab action={action} notify={(n) => setNotice(n)} />}
        {tab === "logs" && <LogsTab notify={(n) => setNotice(n)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users tab (P1)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;
const STATUSES = ["", "active", "pending", "disabled", "rejected"];

function UsersTab({ action, notify }: { action: ActionFn; notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PlatformUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<PlatformUserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true);
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
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [search, status, notify]);

  useEffect(() => {
    void load(0);
  }, [load]);

  const doResetPassword = async () => {
    if (!resetFor || resetPassword.length < 8) return;
    if (await action(`/api/admin/users/${resetFor.id}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: resetPassword }),
    })) {
      notify(t("已重置 {name} 的密码，其所有旧会话已失效", { name: resetFor.username }));
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
      notify(t("已将 {name} 置为 {status}", { name: user.username, status: next }));
      void load(offset);
    }
  };

  const doDelete = async (user: PlatformUserRow) => {
    if (!window.confirm(t("确定删除用户 {name}？其容器与工作区将一并清理", { name: user.username }))) return;
    if (await action(`/api/admin/users/${user.id}`, { method: "DELETE" })) {
      notify(t("已删除 {name}", { name: user.username }));
      void load(offset);
    }
  };

  const doApprove = async (user: PlatformUserRow, act: "approve" | "reject") => {
    if (await action(`/api/admin/users/${user.id}/${act}`, { method: "POST" })) {
      notify(act === "approve" ? t("已批准 {name}", { name: user.username }) : t("已拒绝 {name}", { name: user.username }));
      void load(offset);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(0); }}
          placeholder={t("搜索用户名/邮箱")}
          style={{ flex: 1, minWidth: 160, padding: "5px 9px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: "5px 7px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s === "" ? t("全部状态") : s}</option>)}
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
          onCreated={async (name) => { setCreating(false); notify(t("已创建用户 {name}", { name })); await load(0); }}
          action={action}
          t={t}
        />
      )}

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
            {loading && <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("没有匹配的用户")}</td></tr>}
            {!loading && rows.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{u.id}</td>
                <td style={{ padding: "7px 8px", fontWeight: 500 }}>
                  {u.username}
                  {u.must_change_password && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--warning, #eab308)" }} title={t("下次登录须改密")}>⟳</span>}
                </td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)" }}>{u.email ?? "—"}</td>
                <td style={{ padding: "7px 8px" }}>{u.role}</td>
                <td style={{ padding: "7px 8px", color: statusColor(u.status) }}>{u.status}</td>
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

      <Pager page={page} pages={pages} loading={loading} onNav={(o) => void load(o)} pageSize={PAGE_SIZE} total={total} noun={t("人")} />

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
    </>
  );
}

function CreateUserForm({ onCancel, onCreated, action, t }: {
  onCancel: () => void;
  onCreated: (name: string) => void;
  action: ActionFn;
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

// ---------------------------------------------------------------------------
// Containers tab (P2)
// ---------------------------------------------------------------------------

const CONTAINER_FILTERS = ["", "running", "stopped"];

function ContainersTab({ action, notify }: { action: ActionFn; notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PlatformContainerRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (status) params.set("status", status);
      const res = await fetch(`/api/admin/containers?${params}`, { credentials: "same-origin" });
      const data = (await res.json()) as { containers?: PlatformContainerRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.containers ?? []);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const doLifecycle = async (row: PlatformContainerRow, act: "start" | "stop") => {
    if (await action(`/api/admin/containers/${row.id}/${act}`, { method: "POST" })) {
      notify(act === "start" ? t("已启动容器 {name}", { name: row.name }) : t("已停止容器 {name}", { name: row.name }));
      void load();
    }
  };

  const doDelete = async (row: PlatformContainerRow) => {
    if (!window.confirm(t("确定删除容器 {name}（{owner}）？实例与可写层将被清理", { name: row.name, owner: row.owner_username ?? "?" }))) return;
    if (await action(`/api/admin/containers/${row.id}`, { method: "DELETE" })) {
      notify(t("已删除容器 {name}", { name: row.name }));
      void load();
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: "5px 7px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}>
          {CONTAINER_FILTERS.map((s) => <option key={s} value={s}>{s === "" ? t("全部状态") : s}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("最多显示最近 50 个")}</span>
        <button type="button" onClick={() => void load()} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}>
          {t("刷新")}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>#</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("名称")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("所有者")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("镜像")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("状态")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("资源")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("没有容器")}</td></tr>}
            {!loading && rows.map((c) => (
              <tr key={c.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{c.id}</td>
                <td style={{ padding: "7px 8px", fontWeight: 500 }} title={c.error_message ?? undefined}>
                  {c.name}
                  {c.error_message && <span style={{ marginLeft: 6, fontSize: 10, color: "#f87171" }} title={c.error_message}>⚠</span>}
                </td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)" }}>{c.owner_username ?? `u${c.id}`}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>#{c.image_id}</td>
                <td style={{ padding: "7px 8px", color: statusColor(c.status) }}>{c.status}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {c.cpu}c·{Math.round(c.memory_mb / 1024)}G·{c.disk_gb}G
                </td>
                <td style={{ padding: "7px 8px", whiteSpace: "nowrap" }}>
                  {c.status === "running"
                    ? <MiniButton onClick={() => void doLifecycle(c, "stop")}>{t("停止")}</MiniButton>
                    : <MiniButton onClick={() => void doLifecycle(c, "start")} accent>{t("启动")}</MiniButton>}
                  <MiniButton onClick={() => void doDelete(c)} danger>{t("删除")}</MiniButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Images tab (P2)
// ---------------------------------------------------------------------------

function ImagesTab({ action, notify }: { action: ActionFn; notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PlatformImageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/images", { credentials: "same-origin" });
      const data = (await res.json()) as { images?: PlatformImageRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.images ?? []);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const doTogglePublic = async (img: PlatformImageRow) => {
    const next = !img.is_public;
    if (await action(`/api/admin/images/${img.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_public: next }),
    })) {
      notify(next ? t("镜像 {name} 已设为公开", { name: img.display_name }) : t("镜像 {name} 已设为私有", { name: img.display_name }));
      void load();
    }
  };

  const doDelete = async (img: PlatformImageRow) => {
    if (!window.confirm(t("确定删除镜像 {name}？（不影响已用该镜像创建的容器）", { name: img.display_name }))) return;
    if (await action(`/api/admin/images/${img.id}`, { method: "DELETE" })) {
      notify(t("已删除镜像 {name}", { name: img.display_name }));
      void load();
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("镜像目录（sif 需先放到平台可访问的路径）")}</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => void load()} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}>
          {t("刷新")}
        </button>
        <button type="button" onClick={() => setCreating((v) => !v)} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer" }}>
          {creating ? t("取消") : t("+ 注册镜像")}
        </button>
      </div>

      {creating && (
        <CreateImageForm
          onCancel={() => setCreating(false)}
          onCreated={async (name) => { setCreating(false); notify(t("已注册镜像 {name}", { name })); await load(); }}
          action={action}
          t={t}
        />
      )}

      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>#</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("显示名")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("名称")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>sif</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("可见性")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("镜像目录为空")}</td></tr>}
            {!loading && rows.map((img) => (
              <tr key={img.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{img.id}</td>
                <td style={{ padding: "7px 8px", fontWeight: 500 }} title={img.description ?? undefined}>{img.display_name}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{img.name}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={img.sif_path}>{img.sif_path}</td>
                <td style={{ padding: "7px 8px" }}>
                  {img.is_public
                    ? <span style={{ color: "var(--success, #22c55e)" }}>{t("公开")}</span>
                    : <span style={{ color: "var(--text-dim)" }}>{t("私有")}</span>}
                </td>
                <td style={{ padding: "7px 8px", whiteSpace: "nowrap" }}>
                  <MiniButton onClick={() => void doTogglePublic(img)}>
                    {img.is_public ? t("设为私有") : t("设为公开")}
                  </MiniButton>
                  <MiniButton onClick={() => void doDelete(img)} danger>{t("删除")}</MiniButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CreateImageForm({ onCancel, onCreated, action, t }: {
  onCancel: () => void;
  onCreated: (name: string) => void;
  action: ActionFn;
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [sifPath, setSifPath] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);

  const valid = /^[a-zA-Z0-9_.\/-]+$/.test(name) && displayName && sifPath;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const ok = await action("/api/admin/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, display_name: displayName, sif_path: sifPath, ...(description ? { description } : {}), is_public: isPublic }),
    });
    setBusy(false);
    if (ok) onCreated(displayName);
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
      {field(name, setName, t("名称（字母/数字/_./-）"), true)}
      {field(displayName, setDisplayName, t("显示名"))}
      {field(sifPath, setSifPath, "/path/to/image.sif", true)}
      {field(description, setDescription, t("描述（可选）"))}
      <label style={{ fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        {t("公开")}
      </label>
      <button type="button" disabled={busy || !valid} onClick={() => void submit()} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer", opacity: busy || !valid ? 0.4 : 1 }}>
        {t("注册")}
      </button>
      <button type="button" onClick={onCancel} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", color: "var(--text-muted)", background: "none", borderRadius: 6, cursor: "pointer" }}>
        {t("取消")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// P3 tabs: overview / quotas / workspaces / llm / logs
// ---------------------------------------------------------------------------

interface OverviewData {
  users: number;
  images: number;
  runningContainers: number;
  recentFailures24h: number;
  containersByStatus: Record<string, number>;
  executor: string;
  dialect: string;
}

function OverviewTab({ notify }: { notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/overview", { credentials: "same-origin" });
      const json = (await res.json()) as OverviewData & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("加载中…")}</div>;
  }
  if (!data) return null;

  const cards: Array<[string, string | number, string?]> = [
    [t("用户总数"), data.users],
    [t("运行中容器"), data.runningContainers],
    [t("镜像数"), data.images],
    [t("24h 失败操作"), data.recentFailures24h, data.recentFailures24h > 0 ? "#f87171" : undefined],
  ];

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
        {cards.map(([label, value, color]) => (
          <div key={label} style={{ padding: "12px 14px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: color ?? "var(--text)" }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {Object.entries(data.containersByStatus).map(([status, count]) => (
          <span key={status} style={{ fontSize: 11.5, padding: "3px 10px", borderRadius: 999, border: "1px solid var(--border)", color: statusColor(status) }}>
            {status}: <strong style={{ fontFamily: "var(--font-mono)" }}>{count}</strong>
          </span>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {t("执行器：{kind} · 数据库：{dialect}", { kind: data.executor, dialect: data.dialect })}
      </div>
      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={() => void load()} style={{ ...pagerBtn }}>{t("刷新")}</button>
      </div>
    </div>
  );
}

interface QuotaRow {
  id: number;
  name: string;
  description: string | null;
  max_containers: number;
  max_cpu_cores: number;
  max_memory_mb: number;
  max_disk_gb: number;
  max_snapshots_per_container: number;
  max_workspaces_per_user?: number | null;
}

function QuotasTab({ action, notify }: { action: ActionFn; notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<QuotaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QuotaRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/quotas", { credentials: "same-origin" });
      const data = (await res.json()) as { quotas?: QuotaRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.quotas ?? []);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const doDelete = async (q: QuotaRow) => {
    if (!window.confirm(t("确定删除配额 {name}？使用该配额的用户将失去配额限制依据", { name: q.name }))) return;
    if (await action(`/api/admin/quotas/${q.id}`, { method: "DELETE" })) {
      notify(t("已删除配额 {name}", { name: q.name }));
      void load();
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("配额层级（限制每用户可创建的容器/工作区数量与资源）")}</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setCreating((v) => !v)} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer" }}>
          {creating ? t("取消") : t("+ 新建配额")}
        </button>
      </div>
      {creating && (
        <QuotaForm
          onCancel={() => setCreating(false)}
          onSaved={async () => { setCreating(false); notify(t("配额已创建")); await load(); }}
          action={action}
          t={t}
        />
      )}
      {editing && (
        <QuotaForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); notify(t("配额已更新")); await load(); }}
          action={action}
          t={t}
        />
      )}
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>#</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("名称")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("容器")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>CPU</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("内存")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("磁盘")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("快照/容器")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.map((q) => (
              <tr key={q.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{q.id}</td>
                <td style={{ padding: "7px 8px", fontWeight: 500 }} title={q.description ?? undefined}>{q.name}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)" }}>{q.max_containers}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)" }}>{q.max_cpu_cores}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)" }}>{Math.round(q.max_memory_mb / 1024)}G</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)" }}>{q.max_disk_gb}G</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)" }}>{q.max_snapshots_per_container}</td>
                <td style={{ padding: "7px 8px", whiteSpace: "nowrap" }}>
                  <MiniButton onClick={() => setEditing(q)} accent>{t("编辑")}</MiniButton>
                  <MiniButton onClick={() => void doDelete(q)} danger>{t("删除")}</MiniButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function QuotaForm({ initial, onCancel, onSaved, action, t }: {
  initial?: QuotaRow;
  onCancel: () => void;
  onSaved: () => void;
  action: ActionFn;
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [maxContainers, setMaxContainers] = useState(String(initial?.max_containers ?? 5));
  const [maxCpu, setMaxCpu] = useState(String(initial?.max_cpu_cores ?? 4));
  const [maxMemGb, setMaxMemGb] = useState(String(Math.round((initial?.max_memory_mb ?? 8192) / 1024)));
  const [maxDiskGb, setMaxDiskGb] = useState(String(initial?.max_disk_gb ?? 20));
  const [maxSnapshots, setMaxSnapshots] = useState(String(initial?.max_snapshots_per_container ?? 5));
  const [busy, setBusy] = useState(false);

  const valid = name.length > 0 && /^\d+$/.test(maxContainers) && /^\d+$/.test(maxCpu) && /^\d+$/.test(maxMemGb) && /^\d+$/.test(maxDiskGb) && /^\d+$/.test(maxSnapshots);
  const num = (v: string) => Number(v);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const body = { name, description: description || undefined, max_containers: num(maxContainers), max_cpu_cores: num(maxCpu), max_memory_mb: num(maxMemGb) * 1024, max_disk_gb: num(maxDiskGb), max_snapshots_per_container: num(maxSnapshots) };
    const ok = initial
      ? await action(`/api/admin/quotas/${initial.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      : await action("/api/admin/quotas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (ok) onSaved();
  };

  const field = (label: string, value: string, set: (v: string) => void, width = 70) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, color: "var(--text-dim)" }}>
      {label}
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        style={{ width, padding: "5px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)" }}
      />
    </label>
  );

  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap", alignItems: "flex-end" }}>
      {field(t("名称"), name, setName, 110)}
      {field(t("描述"), description, setDescription, 160)}
      {field(t("容器上限"), maxContainers, setMaxContainers)}
      {field("CPU", maxCpu, setMaxCpu)}
      {field(t("内存 (GB)"), maxMemGb, setMaxMemGb)}
      {field(t("磁盘 (GB)"), maxDiskGb, setMaxDiskGb)}
      {field(t("快照上限"), maxSnapshots, setMaxSnapshots)}
      <button type="button" disabled={busy || !valid} onClick={() => void submit()} style={{ padding: "6px 14px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer", opacity: busy || !valid ? 0.4 : 1 }}>
        {initial ? t("保存") : t("创建")}
      </button>
      <button type="button" onClick={onCancel} style={{ padding: "6px 14px", fontSize: 12, border: "1px solid var(--border)", color: "var(--text-muted)", background: "none", borderRadius: 6, cursor: "pointer" }}>
        {t("取消")}
      </button>
    </div>
  );
}

interface WorkspaceRow {
  id: number;
  name: string;
  owner_username?: string | null;
  description: string | null;
  size_bytes: number;
  file_count: number;
  source_container_id: number | null;
  created_at: string;
}

function WorkspacesTab({ action, notify }: { action: ActionFn; notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const PAGE = 20;

  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/admin/workspaces?${params}`, { credentials: "same-origin" });
      const data = (await res.json()) as { workspaces?: WorkspaceRow[]; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.workspaces ?? []);
      setTotal(data.total ?? 0);
      setOffset(nextOffset);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [search, notify]);

  useEffect(() => {
    void load(0);
  }, [load]);

  const doDelete = async (ws: WorkspaceRow) => {
    if (!window.confirm(t("确定删除工作区 {name}（{owner}）？存储目录将一并删除", { name: ws.name, owner: ws.owner_username ?? "?" }))) return;
    if (await action(`/api/admin/workspaces/${ws.id}`, { method: "DELETE" })) {
      notify(t("已删除工作区 {name}", { name: ws.name }));
      void load(offset);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;
  const fmtSize = (bytes: number): string =>
    bytes > 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G` : bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}M` : `${Math.round(bytes / 1024)}K`;

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(0); }}
          placeholder={t("搜索工作区名称")}
          style={{ flex: 1, padding: "5px 9px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
        />
        <button type="button" onClick={() => void load(0)} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}>
          {t("搜索")}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>#</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("名称")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("所有者")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("大小")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("文件数")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("来源容器")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("没有工作区")}</td></tr>}
            {!loading && rows.map((ws) => (
              <tr key={ws.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{ws.id}</td>
                <td style={{ padding: "7px 8px", fontWeight: 500 }} title={ws.description ?? undefined}>{ws.name}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)" }}>{ws.owner_username ?? "—"}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>{fmtSize(ws.size_bytes)}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>{ws.file_count}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>{ws.source_container_id ? `#${ws.source_container_id}` : "—"}</td>
                <td style={{ padding: "7px 8px" }}>
                  <MiniButton onClick={() => void doDelete(ws)} danger>{t("删除")}</MiniButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} loading={loading} onNav={(o) => void load(o)} pageSize={PAGE} total={total} noun={t("个")} />
    </>
  );
}

interface LlmBindingRow {
  id: number;
  platform_user_id: number;
  username?: string | null;
  max_budget: number;
  budget_duration: string | null;
  models: string[] | null;
  granted_at: string;
  revoked_at: string | null;
}

function LlmTab({ action, notify }: { action: ActionFn; notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<LlmBindingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantBudget, setGrantBudget] = useState("10");
  const [plaintext, setPlaintext] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/llm/bindings", { credentials: "same-origin" });
      const data = (await res.json()) as { bindings?: LlmBindingRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.bindings ?? []);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const doGrant = async () => {
    if (!/^\d+$/.test(grantUserId) || !/^\d+(\.\d+)?$/.test(grantBudget)) return;
    const ok = await action("/api/admin/llm/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platformUserId: Number(grantUserId), maxBudget: Number(grantBudget), budgetDuration: "monthly" }),
    });
    if (ok) {
      notify(t("已授权用户 #{id}（预算 {budget}/月）", { id: grantUserId, budget: grantBudget }));
      setGrantUserId("");
      void load();
    }
  };

  const doRevoke = async (b: LlmBindingRow) => {
    if (!window.confirm(t("确定撤销用户 #{id} 的 LLM 访问？其虚拟密钥将立即失效", { id: String(b.platform_user_id) }))) return;
    if (await action(`/api/admin/llm/bindings/${b.platform_user_id}`, { method: "DELETE" })) {
      notify(t("已撤销用户 #{id} 的 LLM 访问", { id: String(b.platform_user_id) }));
      void load();
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("LLM 访问授权（绑定平台用户与虚拟密钥预算）")}</span>
        <div style={{ flex: 1 }} />
        <input
          value={grantUserId}
          onChange={(e) => setGrantUserId(e.target.value)}
          placeholder={t("用户 #id")}
          style={{ width: 90, padding: "5px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)" }}
        />
        <input
          value={grantBudget}
          onChange={(e) => setGrantBudget(e.target.value)}
          placeholder={t("预算")}
          style={{ width: 70, padding: "5px 8px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          disabled={!/^\d+$/.test(grantUserId) || !/^\d+(\.\d+)?$/.test(grantBudget)}
          onClick={() => void doGrant()}
          style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--accent)", color: "var(--accent)", background: "none", borderRadius: 6, cursor: "pointer", opacity: !/^\d+$/.test(grantUserId) || !/^\d+(\.\d+)?$/.test(grantBudget) ? 0.4 : 1 }}
        >
          {t("授权")}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>#</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("用户")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("预算")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("周期")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("模型")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("状态")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={7} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("没有 LLM 授权")}</td></tr>}
            {!loading && rows.map((b) => (
              <tr key={b.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{b.id}</td>
                <td style={{ padding: "7px 8px", fontWeight: 500 }}>#{b.platform_user_id}{b.username ? ` ${b.username}` : ""}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)" }}>{b.max_budget}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)" }}>{b.budget_duration ?? "—"}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)", fontSize: 11 }}>{b.models ? b.models.join(", ") : t("全部")}</td>
                <td style={{ padding: "7px 8px", color: b.revoked_at ? "var(--text-dim)" : "var(--success, #22c55e)" }}>{b.revoked_at ? t("已撤销") : t("生效中")}</td>
                <td style={{ padding: "7px 8px" }}>
                  {!b.revoked_at && <MiniButton onClick={() => void doRevoke(b)} danger>{t("撤销")}</MiniButton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

interface LogRow {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string | null;
  resource_id: number | null;
  status: string;
  detail: string | null;
  created_at: string;
}

function LogsTab({ notify }: { notify: (msg: string) => void }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const PAGE = 30;

  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (actionFilter.trim()) params.set("action", actionFilter.trim());
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/logs?${params}`, { credentials: "same-origin" });
      const data = (await res.json()) as { logs?: LogRow[]; total?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.logs ?? []);
      setTotal(data.total ?? 0);
      setOffset(nextOffset);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [actionFilter, statusFilter, notify]);

  useEffect(() => {
    void load(0);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  return (
    <>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
        <input
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(0); }}
          placeholder={t("按操作过滤（如 container.create）")}
          style={{ flex: 1, padding: "5px 9px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontFamily: "var(--font-mono)" }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: "5px 7px", fontSize: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}>
          <option value="">{t("全部状态")}</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
        </select>
        <button type="button" onClick={() => void load(0)} style={{ padding: "5px 12px", fontSize: 12, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", borderRadius: 6, cursor: "pointer" }}>
          {t("搜索")}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-dim)", fontSize: 10.5 }}>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("时间")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("用户")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("操作")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("资源")}</th>
              <th style={{ padding: "8px 8px", fontWeight: 500 }}>{t("状态")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("加载中…")}</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={5} style={{ padding: 18, textAlign: "center", color: "var(--text-dim)" }}>{t("没有日志")}</td></tr>}
            {!loading && rows.map((log) => (
              <tr key={log.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap" }}>
                  {log.created_at?.replace("T", " ").slice(0, 19)}
                </td>
                <td style={{ padding: "7px 8px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{log.user_id ?? "—"}</td>
                <td style={{ padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 11 }} title={log.detail ?? undefined}>{log.action}</td>
                <td style={{ padding: "7px 8px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {log.resource_type ? `${log.resource_type}${log.resource_id ? `#${log.resource_id}` : ""}` : "—"}
                </td>
                <td style={{ padding: "7px 8px", color: log.status === "failure" ? "#f87171" : "var(--success, #22c55e)" }}>{log.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pages} loading={loading} onNav={(o) => void load(o)} pageSize={PAGE} total={total} noun={t("条")} />
    </>
  );
}

function statusColor(s: string): string {
  return (
    {
      active: "var(--success, #22c55e)",
      running: "var(--success, #22c55e)",
      pending: "var(--warning, #eab308)",
      stopped: "var(--text-dim)",
      disabled: "var(--text-dim)",
      rejected: "var(--text-dim)",
      error: "#f87171",
    } as Record<string, string>
  )[s] ?? "var(--text-muted)";
}

function Pager({ page, pages, loading, onNav, pageSize, total, noun }: {
  page: number; pages: number; loading: boolean; onNav: (offset: number) => void; pageSize: number; total: number; noun: string;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)" }}>
      <span>{t("共 {total} {noun}", { total: String(total), noun })}</span>
      <div style={{ flex: 1 }} />
      <button type="button" disabled={page <= 1 || loading} onClick={() => onNav(Math.max(0, (page - 2) * pageSize))} style={{ ...pagerBtn, opacity: page <= 1 ? 0.4 : 1 }}>{t("上一页")}</button>
      <span>{page} / {pages}</span>
      <button type="button" disabled={page >= pages || loading} onClick={() => onNav(page * pageSize)} style={{ ...pagerBtn, opacity: page >= pages ? 0.4 : 1 }}>{t("下一页")}</button>
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
