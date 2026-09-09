import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import {
  createQuickTemplate,
  deleteQuickTemplate,
  listQuickTemplates,
  updateQuickTemplate,
} from "@/lib/quick-templates";

export const dynamic = "force-dynamic";

function isAdmin(req: Request): { ok: boolean; response?: NextResponse } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return { ok: false, response: NextResponse.json({ error: "登录已失效" }, { status: 401 }) };
  }
  const { user } = identity.session;
  // Auth off (implicit admin id=0) also grants management — same as the rest
  // of the admin surface.
  if (user.id !== 0 && user.role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "仅管理员可以管理快速会话模板" }, { status: 403 }) };
  }
  return { ok: true };
}

// GET — every logged-in user lists templates (needed to pick one when
// starting a quick session).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json({ templates: listQuickTemplates() });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const gate = isAdmin(req);
  if (!gate.ok) return gate.response!;
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = createQuickTemplate(body);
  if (result.errors) return NextResponse.json({ errors: result.errors }, { status: 400 });
  return NextResponse.json({ template: result.template });
}

export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const gate = isAdmin(req);
  if (!gate.ok) return gate.response!;
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; template?: unknown };
  if (typeof body.id !== "string") return NextResponse.json({ error: "id required" }, { status: 400 });
  const result = updateQuickTemplate(body.id, (body.template ?? {}) as Record<string, unknown>);
  if (result.errors) return NextResponse.json({ errors: result.errors }, { status: 400 });
  return NextResponse.json({ template: result.template });
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const gate = isAdmin(req);
  if (!gate.ok) return gate.response!;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const result = deleteQuickTemplate(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
