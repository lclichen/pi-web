import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readModelsConfig());
}

export async function PUT(req: Request) {
  // Rewrites the GLOBAL models.json (every session's default provider list) —
  // admin only, same rule as global plugins/agents/mcp.
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "全局模型配置仅管理员可修改" }, { status: 403 });
  }
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
