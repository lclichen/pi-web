import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { revokeEmbedToken } from "@/lib/embed-tokens";
import { platformDelete } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// DELETE /api/embed/tokens/[id] — revoke a link immediately.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { id } = await params;
  const record = revokeEmbedToken(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!record) return NextResponse.json({ error: "链接不存在" }, { status: 404 });
  if (record.apiKey) {
    await platformDelete(`/api/v1/auth/api-keys/${encodeURIComponent(String(record.apiKeyId))}`, record.apiKey).catch(
      () => {
        // Local revocation is authoritative; platform cleanup is best-effort.
      },
    );
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
