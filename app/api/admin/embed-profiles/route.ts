import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { listEmbedProfiles, saveEmbedProfiles } from "@/lib/embed-profiles";
import { revokeEmbedAccessForProduct } from "@/lib/embed-access";

export const dynamic = "force-dynamic";

// GET /api/admin/embed-profiles — full product configuration.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
      { status: identity.status },
    );
  }
  return NextResponse.json({ products: listEmbedProfiles() }, { headers: { "Cache-Control": "no-store" } });
}

// PUT /api/admin/embed-profiles — replace the list (validated atomically).
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
      { status: identity.status },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const products =
    body && typeof body === "object" && !Array.isArray(body) && "products" in body
      ? (body as { products: unknown }).products
      : body;
  try {
    const before = new Set(listEmbedProfiles().map((product) => product.id));
    const saved = saveEmbedProfiles(products);
    // Group/config changes take effect immediately: force embedded pages to
    // re-exchange with their API key.
    for (const id of new Set([...before, ...saved.map((product) => product.id)])) {
      revokeEmbedAccessForProduct(id);
    }
    return NextResponse.json({ products: saved }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
