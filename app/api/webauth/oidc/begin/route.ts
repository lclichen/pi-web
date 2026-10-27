import { NextResponse } from "next/server";
import { platformUrl } from "@/lib/platform/client";
import { isWebAuthEnabled } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/webauth/oidc/begin — 跳转到平台的 OIDC 授权入口（授权码流+PKCE
// 都发生在平台侧），授权完成后平台带一次性 handoff code 回跳
// /api/webauth/oidc/callback。浏览器不接触平台地址配置。
export async function GET(req: Request) {
  if (!isWebAuthEnabled()) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const origin = new URL(req.url).origin;
  const begin = new URL(`${platformUrl().replace(/\/+$/, "")}/api/v1/auth/oidc/begin`);
  begin.searchParams.set("redirect_uri", `${origin}/api/webauth/oidc/callback`);
  return NextResponse.redirect(begin);
}
