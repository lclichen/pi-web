import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { resolveSessionAccess, sessionOwnerInfo } from "@/lib/session-access";
import { getRpcSession } from "@/lib/rpc-manager";
import { setAdminTakeover } from "@/lib/admin-takeover";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/sessions/[id]/takeover { active: boolean }
 *
 * 管理员支持视图的写入门闩：默认只读；这里显式开启/关闭接管（1 小时、仅
 * 本进程、仅当前管理员）。普通用户无权限。
 */
export async function POST(req: Request, ctx: Ctx) {
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
      { status: identity.status },
    );
  }
  const { id } = await ctx.params;
  let body: { active?: unknown };
  try {
    body = (await req.json()) as { active?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const access = await resolveSessionAccess(req, id);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const live = getRpcSession(id)?.isAlive() ?? false;
  if (!live && !access.path) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const active = body.active === true;
  setAdminTakeover(id, identity.session.user.id, active);
  const owner = sessionOwnerInfo(id);
  return NextResponse.json({ ok: true, active, ownerId: owner.ownerId, ownerName: owner.ownerName ?? null });
}
