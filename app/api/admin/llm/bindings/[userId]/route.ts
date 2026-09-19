import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformDelete, platformPatch } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// PATCH /api/admin/llm/bindings/[userId] {maxBudget?, budgetDuration?, models?}
// DELETE /api/admin/llm/bindings/[userId] — revoke access.
async function guard(req: Request): Promise<{ ok: true; key: string } | { ok: false; status: number }> {
  if (!isApiRequestAllowed(req)) return { ok: false, status: 403 };
  const identity = requireAdminIdentity(req);
  if (!identity.ok) return { ok: false, status: identity.status };
  return { ok: true, key: identity.session.apiKey };
}

export async function PATCH(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const g = await guard(req);
  if (!g.ok) {
    return NextResponse.json({ error: g.status === 403 ? "仅管理员可用" : "登录已失效" }, { status: g.status });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { userId } = await params;
  if (!/^\d+$/.test(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const data = await platformPatch<unknown>(`/api/v1/admin/llm/bindings/${userId}`, g.key, body);
    return NextResponse.json(data);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const g = await guard(req);
  if (!g.ok) {
    return NextResponse.json({ error: g.status === 403 ? "仅管理员可用" : "登录已失效" }, { status: g.status });
  }
  const { userId } = await params;
  if (!/^\d+$/.test(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }
  try {
    await platformDelete<void>(`/api/v1/admin/llm/bindings/${userId}`, g.key);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}
