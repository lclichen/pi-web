import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { deleteBundle, isValidBundleName } from "@/lib/config-bundles-store";

export const dynamic = "force-dynamic";

// DELETE /api/bundles/:name — admin removes a preset config bundle.
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可管理配置模板" }, { status: 403 });
  }
  const { name } = await ctx.params;
  if (!isValidBundleName(name)) {
    return NextResponse.json({ error: "非法模板名" }, { status: 400 });
  }
  const removed = deleteBundle(name);
  if (!removed) return NextResponse.json({ error: "模板不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
