import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformGet, platformPost } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// GET /api/admin/users?search=&status=&limit=&offset=
// POST /api/admin/users {username, password, email?}
// Thin admin-only proxy to the platform's /api/v1/admin/users. The platform
// re-authorizes every call with the forwarded X-API-Key (the admin's key
// minted at pi-web login), so role checks hold on both sides.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.status === 403 ? "仅管理员可用" : "登录已失效" }, { status: identity.status });
  }
  const params = new URL(req.url).searchParams;
  const num = (name: string): number | undefined => {
    const raw = params.get(name);
    return raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  };
  try {
    const data = await platformGet<unknown>("/api/v1/admin/users", identity.session.apiKey, {
      search: params.get("search") ?? undefined,
      status: params.get("status") ?? undefined,
      limit: num("limit"),
      offset: num("offset"),
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
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
  let body: { username?: unknown; password?: unknown; email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const user = await platformPost<unknown>("/api/v1/admin/users", identity.session.apiKey, body);
    return NextResponse.json(user, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: status !== undefined && status >= 400 && status < 500 ? status : 502 },
    );
  }
}
