import { NextResponse } from "next/server";
import { platformAnonPost } from "@/lib/platform/client";
import { isLoopbackHost, readInitialPassword } from "@/lib/initial-password";

export const dynamic = "force-dynamic";

/**
 * GET /api/webauth/first-run —— 登录页加载时探测首启引导（公开端点）。
 *
 * 返回 {needed:false}：无密码文件（源码部署/已消费/未打包）。
 * 返回 {needed:true, hint}：密码文件仍在——回环请求附 password + username
 * （"admin"），非回环只给「请在本机打开」提示（初始密码不出本机）。
 *
 * 密码有效性经平台 login 实测：文件可能在改密后残留（删除是手动引导），
 * 测不通就当作已消费，不再误导用户输入旧密码。
 */
export async function GET(req: Request) {
  const initial = readInitialPassword();
  if (!initial) {
    return NextResponse.json({ needed: false }, { headers: { "Cache-Control": "no-store" } });
  }

  // 文件在 ≠ 密码仍有效：拿去平台验一次（失败可能是已改密，也可能是平台
  // 暂不可用——两种都不该把旧密码推给用户）。
  try {
    const probe = await platformAnonPost("/api/v1/auth/login", {
      username: "admin",
      password: initial,
    });
    if (!probe.ok) {
      return NextResponse.json({ needed: false }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    return NextResponse.json({ needed: false }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!isLoopbackHost(req)) {
    return NextResponse.json(
      { needed: true, hint: "初始密码仅在本机显示：请在这台机器的浏览器里打开 http://127.0.0.1:30141/ 查看。" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { needed: true, username: "admin", password: initial },
    { headers: { "Cache-Control": "no-store" } },
  );
}
