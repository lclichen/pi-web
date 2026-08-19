import { NextResponse } from "next/server";
import { platformAnonPost } from "@/lib/platform/client";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { isWebAuthEnabled } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// POST /api/webauth/register {username, password, email?} — proxy register.
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
  let body: { username?: unknown; password?: unknown; email?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown; email?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : undefined;
  if (!username || !password) {
    return NextResponse.json({ error: "用户名和密码不能为空" }, { status: 400 });
  }

  const res = await platformAnonPost<{ user?: { status?: string }; message?: string }>(
    "/api/v1/auth/register",
    { username, password, ...(email ? { email } : {}) },
  );
  if (!res.ok) {
    return NextResponse.json(
      { error: res.error.message || "注册失败", ...(res.error.code ? { code: res.error.code } : {}) },
      { status: res.status },
    );
  }
  const pending = (res.data as { user?: { status?: string } })?.user?.status === "pending";
  return NextResponse.json({
    success: true,
    pending,
    message: pending
      ? "注册已提交，等待管理员审批后即可登录。"
      : "注册成功，现在可以登录了。",
  }, { status: 201 });
}
