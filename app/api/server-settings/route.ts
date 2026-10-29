import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getServerSettings, updateServerSettings } from "@/lib/server-settings";

export const dynamic = "force-dynamic";

// GET /api/server-settings — deployment-wide settings (any logged-in user;
// the client mainly receives them via /api/webauth/me already).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json(getServerSettings());
}

// PATCH /api/server-settings { labTraining?: boolean } — admin only, no
// restart needed; takes effect for other clients on their next page load.
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "服务器设置仅管理员可修改" }, { status: 403 });
  }
  let body: { labTraining?: unknown; skillhubUrl?: unknown; bundleUploadMaxMb?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch: { labTraining?: boolean; skillhubUrl?: string; bundleUploadMaxMb?: number | null } = {};
  if (typeof body.labTraining === "boolean") patch.labTraining = body.labTraining;
  if (typeof body.skillhubUrl === "string") patch.skillhubUrl = body.skillhubUrl;
  // null 清除覆盖（回到默认上限）；数字/数字字符串由 update 侧校验。
  if (body.bundleUploadMaxMb === null) patch.bundleUploadMaxMb = null;
  else if (typeof body.bundleUploadMaxMb === "number" || typeof body.bundleUploadMaxMb === "string") {
    patch.bundleUploadMaxMb = Number(body.bundleUploadMaxMb);
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "没有可更新的设置字段" }, { status: 400 });
  }
  try {
    return NextResponse.json(updateServerSettings(patch));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
