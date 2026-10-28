import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getQuickTemplate, DEFAULT_TEMPLATE_ID } from "@/lib/quick-templates";
import { ensureQuickSessionWorkspace } from "@/lib/quick-session";

export const dynamic = "force-dynamic";

// GET /api/quick-workspace/:templateId — 解析（或创建）快速会话工作区，
// 返回 { cwd, slug }。前端在新建快速会话时调此接口获得 cwd（类似 host
// 模式的目录选择），保证 isNew/ensure 流程有确定的 cwd。
export async function GET(req: Request, { params }: { params: Promise<{ templateId: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { templateId } = await params;
  const template = getQuickTemplate(templateId) ?? getQuickTemplate(DEFAULT_TEMPLATE_ID);
  if (!template) {
    return NextResponse.json({ error: `快速会话模板不存在：${templateId}` }, { status: 404 });
  }
  const { dir, slug } = ensureQuickSessionWorkspace(identity.session.user.id, template);
  return NextResponse.json({ cwd: dir, slug, templateId: template.id });
}
