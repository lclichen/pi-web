import { NextResponse } from "next/server";
import { platformBrowserUrl } from "@/lib/platform/client";
import { requestOrigin } from "@/lib/request-origin";
import { isWebAuthEnabled } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/webauth/oidc/begin — 跳转到平台的 OIDC 授权入口（授权码流+PKCE
// 都发生在平台侧），授权完成后平台带一次性 handoff code 回跳
// /api/webauth/oidc/callback。浏览器不接触平台地址配置。
export async function GET(req: Request) {
  if (!isWebAuthEnabled()) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  // 用浏览器实际访问的 origin（含 publicBaseUrl / x-forwarded-host），不能
  // 用 new URL(req.url).origin：服务端绑定 0.0.0.0 时它可能是内部地址，
  // 写进 redirect_uri 会让平台把回调发到错误主机。
  const origin = requestOrigin(req).replace(/\/+$/, "");
  const begin = new URL(`${platformBrowserUrl(origin)}/api/v1/auth/oidc/begin`);
  begin.searchParams.set("redirect_uri", `${origin}/api/webauth/oidc/callback`);
  return NextResponse.redirect(begin);
}
