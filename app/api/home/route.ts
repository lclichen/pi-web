import { NextResponse } from "next/server";
import { homedir } from "os";
import { requireUserIdentity } from "@/lib/web-session";

// 服务器 home 路径属于 Host 空间信息，仅管理员（2026-10-26 审计：此前任
// 意登录用户可获取服务器用户名与目录结构起点）。
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }
  return NextResponse.json({ home: homedir() });
}
