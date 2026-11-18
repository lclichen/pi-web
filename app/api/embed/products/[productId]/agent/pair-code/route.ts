import { NextResponse } from "next/server";
import { getEmbedProfile } from "@/lib/embed-profiles";
import { requireEmbedProductIdentity } from "@/lib/embed-product-auth";
import { createPairingCode } from "@/lib/relay/registry";
import { getRelayInfo } from "@/lib/relay/ws-server";
import { getPublicBaseUrl } from "@/lib/server-settings";
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

// POST /api/embed/products/:productId/agent/pair-code
export async function POST(req: Request, { params }: Params) {
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
  let label: string | undefined;
  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { label?: unknown };
    if (typeof body.label === "string" && body.label.trim()) label = body.label.trim().slice(0, 50);
  }
  const pc = createPairingCode(auth.identity.user.id, label);
  const relay = getRelayInfo();
  return withEmbedCors(
    req,
    auth.identity.product,
    NextResponse.json(
      {
        code: pc.code,
        expiresAt: pc.expiresAt,
        relayPort: relay.port,
        advertiseUrl: process.env.PI_RELAY_ADVERTISE_URL ?? null,
        publicBaseUrl: getPublicBaseUrl() ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );
}
