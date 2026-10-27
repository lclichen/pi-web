import { NextResponse } from "next/server";
import { platformAnonPost, platformPostBearer } from "@/lib/platform/client";
import { createWebSession, isWebAuthEnabled, sessionCookieHeader } from "@/lib/web-session";

export const dynamic = "force-dynamic";

interface OidcExchangeResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: number;
    username: string;
    email: string | null;
    role: "admin" | "user";
    status: string;
    must_change_password?: boolean;
  };
}

interface PlatformApiKeyCreated {
  id: number | string;
  key: string;
}

// GET /api/webauth/oidc/callback?code=… — 平台 OIDC 完成后的回跳：用一次性
// handoff code 向平台换取令牌对（服务端对服务端，令牌不进浏览器），
// 然后走与密码登录完全相同的建会话路径（铸 pi-web API key + cookie）。
export async function GET(req: Request) {
  if (!isWebAuthEnabled()) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code") ?? "";
  const loginUrl = new URL("/login", req.url);
  if (!code) {
    loginUrl.searchParams.set("error", "oidc_missing_code");
    return NextResponse.redirect(loginUrl);
  }

  const exchanged = await platformAnonPost<OidcExchangeResponse>("/api/v1/auth/oidc/exchange", { code });
  if (!exchanged.ok) {
    loginUrl.searchParams.set("error", "oidc_exchange_failed");
    return NextResponse.redirect(loginUrl);
  }

  const { accessToken, user: platformUser } = exchanged.data;
  const user = {
    id: platformUser.id,
    username: platformUser.username,
    email: platformUser.email ?? null,
    role: platformUser.role,
    status: platformUser.status,
  };
  if (platformUser.status !== "active") {
    loginUrl.searchParams.set("error", "oidc_account_inactive");
    return NextResponse.redirect(loginUrl);
  }

  // 与密码登录一致：铸一把专用 pi-web API key 作为会话凭证。
  let key: PlatformApiKeyCreated;
  try {
    key = await platformPostBearer<PlatformApiKeyCreated>(
      "/api/v1/auth/api-keys",
      accessToken,
      { name: `pi-web ${new Date().toISOString().slice(0, 10)}` },
    );
  } catch {
    loginUrl.searchParams.set("error", "oidc_key_mint_failed");
    return NextResponse.redirect(loginUrl);
  }

  const session = createWebSession(user, key.key, key.id);
  const home = new URL("/", req.url);
  const response = NextResponse.redirect(home);
  response.headers.set("Set-Cookie", sessionCookieHeader(session.sid));
  return response;
}
