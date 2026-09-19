import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { platformGet } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// GET /api/admin/logs?userId=&action=&resourceType=&status=&limit=&offset=
// Cross-user audit-log search; query params pass straight through to the
// platform's admin logs endpoint.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.status === 403 ? "仅管理员可用" : "登录已失效" }, { status: identity.status });
  }
  const query = new URL(req.url).searchParams;
  const num = (name: string): number | undefined => {
    const raw = query.get(name);
    return raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  };
  try {
    const data = await platformGet<unknown>("/api/v1/admin/logs", identity.session.apiKey, {
      userId: num("userId"),
      action: query.get("action") ?? undefined,
      resourceType: query.get("resourceType") ?? undefined,
      resourceId: num("resourceId"),
      status: query.get("status") ?? undefined,
      limit: num("limit"),
      offset: num("offset"),
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
