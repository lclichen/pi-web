import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformPost } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// POST /api/admin/users/[id]/password {password}
// Admin password reset. The platform hashes, bumps token_version (all the
// target's access tokens die) and revokes their refresh tokens — matching
// semantics as reset-admin-password.ts on the platform side.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.status === 403 ? "仅管理员可用" : "登录已失效" }, { status: identity.status });
  }
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }
  let body: { password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    await platformPost<void>(`/api/v1/admin/users/${id}/password`, identity.session.apiKey, body);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}
