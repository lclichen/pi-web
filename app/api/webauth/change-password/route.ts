import { NextResponse } from "next/server";
import { platformPostBearer } from "@/lib/platform/client";
import { clearSessionCookieHeader, dropWebSession, getWebSession, isWebAuthEnabled } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/webauth/change-password {newPassword}
// Only valid with a change-ticket session (login returned mustChangePassword).
// The platform revokes the refresh family on change; the user re-logs in.
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
  const session = getWebSession(req);
  if (!session?.changeTicket) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  let body: { newPassword?: unknown };
  try {
    body = (await req.json()) as { newPassword?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!newPassword) {
    return NextResponse.json({ error: "新密码不能为空" }, { status: 400 });
  }

  try {
    await platformPostBearer("/api/v1/auth/change-password", session.changeTicket, { newPassword });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `修改密码失败：${message}` }, { status: 400 });
  }
  dropWebSession(req);
  return NextResponse.json(
    { success: true, message: "密码已修改，请使用新密码重新登录。" },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } },
  );
}
