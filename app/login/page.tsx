"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Phase = "login" | "register" | "change-password";

// useSearchParams() requires a Suspense boundary during prerendering; the
// form itself is the boundary's child.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>("login");
  const [registerMode, setRegisterMode] = useState<"off" | "open" | "approval">("off");
  const [oidc, setOidc] = useState<{ enabled: boolean; label: string }>({ enabled: false, label: "OIDC" });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 首启引导：初始密码文件仍在时（打包部署首次运行），回环访问显示
  // admin + 初始密码，非回环给「请在本机打开」提示；首次用它登录成功
  // 后文件被服务端消费，刷新即消失。
  const [firstRun, setFirstRun] = useState<{ username?: string; password?: string; hint?: string } | null>(null);

  useEffect(() => {
    fetch("/api/webauth/config")
      .then((r) => r.json())
      .then((d: { registerMode?: "off" | "open" | "approval"; oidc?: { enabled?: boolean; label?: string } }) => {
        if (d.registerMode) setRegisterMode(d.registerMode);
        if (d.oidc) setOidc({ enabled: d.oidc.enabled === true, label: d.oidc.label ?? "OIDC" });
      })
      .catch(() => {});
    fetch("/api/webauth/first-run")
      .then((r) => r.json())
      .then((d: { needed?: boolean; username?: string; password?: string; hint?: string }) => {
        if (d.needed) setFirstRun({ username: d.username, password: d.password, hint: d.hint });
      })
      .catch(() => {});
    // Returning from a must-change-password login: the cookie session holds
    // the change ticket.
    fetch("/api/webauth/me")
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((d) => {
        if (d?.mustChangePassword) {
          setPhase("change-password");
          return;
        }
        // 已有有效会话（同浏览器其他窗口登录过——cookie jar 是窗口共享的）：
        // 直接回主页，而不是展示登录表单。否则随手再登一次会用新会话覆盖
        // 共享 cookie，把其他窗口"挤掉"（服务端两会话其实都活着，但旧窗口
        // 的下一个请求会带着新 sid 变成另一个身份/触发跳转）。要换账号请
        // 先显式退出。带 ?next= 时仍走表单（可能是权限跳转的定向登录）。
        if (d?.user && !searchParams.get("next")) {
          router.replace("/");
        }
      })
      .catch(() => {});
  }, [router, searchParams]);

  const next = searchParams.get("next") || "/";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (phase === "login") {
        const res = await fetch("/api/webauth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const d = (await res.json()) as { mustChangePassword?: boolean; usedInitialPassword?: boolean; error?: string };
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        if (d.mustChangePassword) {
          setPhase("change-password");
          setNotice("首次登录需要修改密码。");
          return;
        }
        if (d.usedInitialPassword) {
          // 仍在用初始密码——文件已被服务端消费（横幅消失），进站后提示改密。
          setNotice("你正在使用初始密码登录。为了安全，请进入 设置 → 账户 立即修改密码。");
        }
        router.replace(next);
        router.refresh();
      } else if (phase === "register") {
        if (password !== confirmPassword) throw new Error("两次输入的密码不一致");
        const res = await fetch("/api/webauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, ...(email ? { email } : {}) }),
        });
        const d = (await res.json()) as { message?: string; error?: string };
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        setPhase("login");
        setNotice(d.message ?? "注册成功，请登录。");
      } else {
        if (newPassword !== confirmPassword) throw new Error("两次输入的密码不一致");
        if (newPassword.length < 8) throw new Error("新密码至少 8 位");
        const res = await fetch("/api/webauth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword }),
        });
        const d = (await res.json()) as { message?: string; error?: string };
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
        setPhase("login");
        setPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setNotice(d.message ?? "密码已修改，请重新登录。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: "100dvh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--bg, #141517)",
      padding: 24,
    }}>
      <form
        onSubmit={submit}
        style={{
          width: "min(360px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "28px 26px",
          borderRadius: 12,
          border: "1px solid var(--border, #2a2c30)",
          background: "var(--bg-panel, #1b1d20)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 26, fontWeight: 700, color: "var(--text, #e7e7e7)" }}>π</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text, #e7e7e7)" }}>amedac.ai Agent WebUI</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
          {phase === "login" && "使用沙箱平台账号登录"}
          {phase === "register" && (registerMode === "approval" ? "注册后需管理员审批" : "创建新账号")}
          {phase === "change-password" && "修改密码后需重新登录"}
        </div>

        {/* 首启引导：本机访问显示初始账号密码（一键填充）；远程访问只提示。 */}
        {firstRun && (
          <div
            role="status"
            style={{
              display: "flex", flexDirection: "column", gap: 8,
              padding: "10px 12px", borderRadius: 8,
              border: "1px solid rgba(217,119,6,0.4)",
              background: "rgba(217,119,6,0.08)",
              fontSize: 12, lineHeight: 1.6,
              color: "var(--text, #e7e7e7)",
            }}
          >
            {firstRun.password ? (
              <>
                <span style={{ fontWeight: 600 }}>首次运行 —— 初始管理员账号</span>
                <span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                  admin / {firstRun.password}
                </span>
                <button
                  type="button"
                  onClick={() => { setUsername("admin"); setPassword(firstRun.password ?? ""); }}
                  style={{
                    alignSelf: "flex-start", padding: "4px 10px", borderRadius: 6,
                    border: "1px solid var(--border, #2a2c30)",
                    background: "var(--bg, #141517)", color: "var(--text, #e7e7e7)",
                    fontSize: 11.5, cursor: "pointer",
                  }}
                >
                  填入并登录
                </button>
                <span style={{ color: "var(--text-muted, #9a9a9a)" }}>
                  出于安全，初始密码仅在本机（127.0.0.1）显示；登录后请立即在 设置 → 账户 修改密码。
                </span>
              </>
            ) : (
              <span>检测到首次运行：初始管理员密码仅在这台机器的浏览器中显示，
                请在本机打开 http://127.0.0.1:30141/ 查看并登录。</span>
            )}
          </div>
        )}

        {phase !== "change-password" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              style={inputStyle}
            />
          </label>
        )}
        {phase !== "change-password" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={phase === "login" ? "current-password" : "new-password"}
              style={inputStyle}
            />
          </label>
        )}
        {phase === "register" && (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
              邮箱（可选）
              <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
              确认密码
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" style={inputStyle} />
            </label>
          </>
        )}
        {phase === "change-password" && (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
              新密码（至少 8 位）
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" style={inputStyle} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted, #9a9a9a)" }}>
              确认新密码
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" style={inputStyle} />
            </label>
          </>
        )}

        {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
        {notice && <div style={{ fontSize: 12, color: "#4ade80" }}>{notice}</div>}

        <button
          type="submit"
          disabled={busy}
          style={{
            height: 36,
            borderRadius: 8,
            border: "none",
            background: "var(--accent, #4f7cff)",
            color: "white",
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
            marginTop: 4,
          }}
        >
          {busy ? "请稍候…" : phase === "login" ? "登录" : phase === "register" ? "注册" : "修改密码"}
        </button>

        {phase === "login" && oidc.enabled && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <span style={{ flex: 1, height: 1, background: "var(--border, #2a2c30)" }} />
              <span style={{ fontSize: 11, color: "var(--text-dim, #8b8f98)" }}>或</span>
              <span style={{ flex: 1, height: 1, background: "var(--border, #2a2c30)" }} />
            </div>
            <a
              href="/api/webauth/oidc/begin"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                height: 36, borderRadius: 8,
                border: "1px solid var(--border, #2a2c30)",
                background: "transparent", color: "var(--text, #e6e6e6)",
                fontSize: 13, fontWeight: 600, textDecoration: "none", cursor: "pointer", marginTop: 10,
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {`使用${oidc.label}登录`}
            </a>
          </>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          {phase === "login" ? (
            registerMode !== "off" ? (
              <button type="button" onClick={() => { setPhase("register"); setError(null); setNotice(null); }} style={linkStyle}>
                注册账号
              </button>
            ) : <span />
          ) : (
            <button type="button" onClick={() => { setPhase("login"); setError(null); setNotice(null); }} style={linkStyle}>
              返回登录
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

const inputStyle = {
  height: 34,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2c30)",
  background: "var(--bg, #141517)",
  color: "var(--text, #e7e7e7)",
  fontSize: 13,
  outline: "none",
} as const;

const linkStyle = {
  background: "transparent",
  border: "none",
  color: "var(--accent, #4f7cff)",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
} as const;
