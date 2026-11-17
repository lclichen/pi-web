import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listEmbedProfiles } from "@/lib/embed-profiles";

export const dynamic = "force-dynamic";

// GET /api/embed/products — enabled products a user can pick when creating a link.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json(
    {
      products: listEmbedProfiles()
        .filter((profile) => profile.enabled)
        .map((profile) => ({ id: profile.id, name: profile.name })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
