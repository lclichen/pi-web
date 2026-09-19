import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { platformDelete } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// DELETE /api/admin/containers/[id] — admin deletes any container (the
// platform's requireOwned grants admins cross-user rights and cleans up the
// instance + overlay).
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
    return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  }
  try {
    await platformDelete<void>(`/api/v1/containers/${id}`, identity.session.apiKey);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}
