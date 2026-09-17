import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled, sessionCookieRefreshHeader } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/webauth/touch — 会话保活：滑动服务端会话的空闲窗口，并在节流
// 间隔（≥1h）到期时随响应下发刷新的会话 cookie。前端（AppShell）每小时
// ping 一次，保证"页面长期开着、只有 SSE 长连接"的活跃用户 cookie 不会
// 先于服务端会话过期（SSE 头只能在建流时发，覆盖不了这种场景）。
// 认证关闭时是无害的空操作（{ok:true}，不带 cookie）。
export async function GET(req: Request) {
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ ok: true });
  }
  const session = getWebSession(req);
  if (!session || session.changeTicket) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const refreshCookie = sessionCookieRefreshHeader(req);
  return NextResponse.json(
    { ok: true },
    refreshCookie ? { headers: { "Set-Cookie": refreshCookie } } : undefined,
  );
}
