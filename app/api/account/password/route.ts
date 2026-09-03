import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformPost } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// POST /api/account/password {currentPassword, newPassword}
// Proxy to the platform's /api/v1/auth/change-password (source of truth for
// accounts; pi-web sessions ride platform API keys). The platform validates
// the current password, the password policy, and revokes refresh tokens.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "需要 JSON 请求体" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.id === 0) {
    return NextResponse.json({ error: "单用户（免登录）模式没有账号系统" }, { status: 400 });
  }
  if (!identity.session.apiKey) {
    return NextResponse.json({ error: "会话缺少平台凭证，请退出后重新登录再试" }, { status: 401 });
  }

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "无效的 JSON 请求体" }, { status: 400 });
  }
  if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || !body.currentPassword || !body.newPassword) {
    return NextResponse.json({ error: "需要 currentPassword 与 newPassword" }, { status: 400 });
  }

  try {
    await platformPost("/api/v1/auth/change-password", identity.session.apiKey, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /current password/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
