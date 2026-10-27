import { NextResponse } from "next/server";
import { platformAnonGet } from "@/lib/platform/client";
import { isWebAuthEnabled } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/webauth/config — 登录页能力位：注册模式 + OIDC 开关（平台
// /api/v1/auth/config 透传；平台不可达时全部按关闭呈现）。
export async function GET() {
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ registerMode: "off", oidc: { enabled: false } });
  }
  try {
    const res = await platformAnonGet<{ registerMode: string; oidc?: { enabled?: boolean; label?: string } }>(
      "/api/v1/auth/config",
    );
    if (res.ok) {
      return NextResponse.json({
        registerMode: res.data.registerMode,
        oidc: { enabled: res.data.oidc?.enabled === true, label: res.data.oidc?.label ?? "OIDC" },
      });
    }
  } catch {
    // platform unreachable — fall through
  }
  return NextResponse.json({ registerMode: "off", oidc: { enabled: false } });
}
