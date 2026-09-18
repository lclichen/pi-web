import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformDelete, platformPatch } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// PATCH /api/admin/users/[id] {status?, role?, ...}
// DELETE /api/admin/users/[id]
// Thin admin-only proxy; the platform enforces the last-admin self-protection
// rules and re-authorizes the forwarded X-API-Key on every call.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const user = await platformPatch<unknown>(`/api/v1/admin/users/${id}`, identity.session.apiKey, body);
    return NextResponse.json(user);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.status === 403 ? "仅管理员可用" : "登录已失效" }, { status: identity.status });
  }
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }
  try {
    await platformDelete<void>(`/api/v1/admin/users/${id}`, identity.session.apiKey);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}
