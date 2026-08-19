import { NextResponse } from "next/server";
import { platformAnonPost, platformPostBearer, type PlatformApiKeyCreated, type PlatformLoginResponse } from "@/lib/platform/client";
import { createWebSession, isWebAuthEnabled, sessionCookieHeader } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/webauth/login {username, password}
// Proxies platform login, then mints a long-lived platform API key for the
// user so the BFF never has to manage token refresh. A must-change-password
// login returns a restricted change-ticket session instead.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ error: "PI_WEB_AUTH is not enabled" }, { status: 400 });
  }
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "用户名和密码不能为空" }, { status: 400 });
  }

  const login = await platformAnonPost<PlatformLoginResponse>("/api/v1/auth/login", { username, password });
  if (!login.ok) {
    const status = login.status;
    return NextResponse.json(
      {
        error: login.error.message || "登录失败",
        ...(login.error.code ? { code: login.error.code } : {}),
      },
      { status: status >= 400 && status < 500 ? status : 401 },
    );
  }

  const user = {
    id: login.data.user.id,
    username: login.data.user.username,
    email: login.data.user.email ?? null,
    role: login.data.user.role,
    status: login.data.user.status,
  };

  if (login.data.user.must_change_password) {
    const session = createWebSession(user, "", "", login.data.accessToken);
    return NextResponse.json(
      { mustChangePassword: true },
      { headers: { "Set-Cookie": sessionCookieHeader(session.sid) } },
    );
  }

  // Mint a dedicated pi-web API key (plaintext returned only here).
  let key: PlatformApiKeyCreated;
  try {
    key = await platformPostBearer<PlatformApiKeyCreated>(
      "/api/v1/auth/api-keys",
      login.data.accessToken,
      { name: "pi-web" },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `创建平台 API Key 失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const session = createWebSession(user, key.key, key.id);
  return NextResponse.json(
    { user: session.user },
    { headers: { "Set-Cookie": sessionCookieHeader(session.sid) } },
  );
}
