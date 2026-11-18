import { NextResponse } from "next/server";
import { getEmbedProfile } from "@/lib/embed-profiles";
import { requireEmbedProductIdentity } from "@/lib/embed-product-auth";
import { getMachinesForUser } from "@/lib/relay/registry";
import { embedCorsPreflight, isEmbedOriginAllowed, withEmbedCors } from "@/lib/embed-cors";
import { isApiRequestHostAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string }> };

export async function OPTIONS(req: Request, { params }: Params) {
  const { productId } = await params;
  const product = getEmbedProfile(productId);
  if (!product || !product.enabled) return new NextResponse(null, { status: 404 });
  return embedCorsPreflight(req, product);
}

// GET /api/embed/products/:productId/agent/machines
export async function GET(req: Request, { params }: Params) {
  const { productId } = await params;
  if (!isApiRequestHostAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const auth = await requireEmbedProductIdentity(req, productId);
  if (!auth.ok) {
    const product = getEmbedProfile(productId);
    const response = NextResponse.json({ error: auth.error }, { status: auth.status });
    return product ? withEmbedCors(req, product, response) : response;
  }
  if (!isEmbedOriginAllowed(auth.identity.product, req.headers.get("origin"))) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }
  return withEmbedCors(
    req,
    auth.identity.product,
    NextResponse.json(
      { machines: getMachinesForUser(auth.identity.user.id) },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
}
