import { NextResponse } from "next/server";
import { isWebAuthEnabled, requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { platformGet } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// GET /api/account — current web user's platform profile (settings → 用户 tab).
// Proxied server-side so the browser never needs the platform URL or token.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ authEnabled: false });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  // 已登录但会话里没有平台凭证（must_change_password 门票会话等）——
  // 返回会话里已知的用户信息，改密表单仍可用（走平台 JWT 的路径除外，
  // 这里直接给出让用户重新登录的提示）。
  if (!identity.session.apiKey) {
    return NextResponse.json({
      authEnabled: true,
      user: identity.session.user,
      credentialAvailable: false,
    });
  }

  try {
    const me = await platformGet<{ user: { id: number; username: string; email: string | null; role: string; status: string; must_change_password?: boolean } }>(
      "/api/v1/auth/me",
      identity.session.apiKey,
    );
    return NextResponse.json({
      authEnabled: true,
      credentialAvailable: true,
      user: {
        id: me.user.id,
        username: me.user.username,
        email: me.user.email ?? null,
        role: me.user.role,
        status: me.user.status,
        mustChangePassword: Boolean(me.user.must_change_password),
      },
    });
  } catch {
    // 平台不可达/凭证失效时回落到会话快照，界面仍可展示基本身份。
    return NextResponse.json({
      authEnabled: true,
      credentialAvailable: false,
      user: identity.session.user,
    });
  }
}
