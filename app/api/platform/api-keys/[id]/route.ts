import { NextResponse } from "next/server";
import { platformDelete } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { vaultRemoveApiKey } from "@/lib/api-key-vault";

export const dynamic = "force-dynamic";

// DELETE /api/platform/api-keys/:id — 平台侧吊销 + 清理保管条目。
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const session = identity.session;
  if (!session.apiKey) {
    return NextResponse.json({ error: "当前登录态没有平台凭证" }, { status: 400 });
  }
  const { id } = await params;
  const keyId = Number(id);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return NextResponse.json({ error: "非法密钥 id" }, { status: 400 });
  }
  try {
    // 平台按 user_id 校验归属（service 层 WHERE id=? AND user_id=?）——他人
    // 的 id 会 404，不会误删。
    await platformDelete(`/api/v1/auth/api-keys/${keyId}`, session.apiKey);
  } catch (e) {
    return NextResponse.json({ error: `平台请求失败: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
  try {
    vaultRemoveApiKey(session.user.id, keyId);
  } catch {
    // 保管清理失败不影响吊销结果（条目留着无害：平台已删，列表不再返回）
  }
  return NextResponse.json({ ok: true });
}
