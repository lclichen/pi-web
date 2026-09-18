import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { platformPost } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// POST /api/admin/users/[id]/approve — approval-queue action for a pending
// self-registration. Thin admin-only proxy; the platform enforces state.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    const user = await platformPost<unknown>("/api/v1/admin/users/" + id + "/approve", identity.session.apiKey);
    return NextResponse.json(user);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}
