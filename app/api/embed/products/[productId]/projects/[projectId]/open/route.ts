import { NextResponse } from "next/server";
import { getEmbedProfile } from "@/lib/embed-profiles";
import { requireEmbedProductIdentity } from "@/lib/embed-product-auth";
import {
  embedConfigUpdateAvailable,
  getBoundEmbedProject,
  openEmbedProject,
} from "@/lib/embed-workspaces";
import { embedCorsPreflight, isEmbedOriginAllowed, withEmbedCors } from "@/lib/embed-cors";
import { isApiRequestHostAllowed } from "@/lib/request-security";
import { requestOrigin } from "@/lib/request-origin";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string; projectId: string }> };

export async function OPTIONS(req: Request, { params }: Params) {
  const { productId } = await params;
  const product = getEmbedProfile(productId);
  if (!product || !product.enabled) return new NextResponse(null, { status: 404 });
  return embedCorsPreflight(req, product);
}

// POST /api/embed/products/:productId/projects/:projectId/open
export async function POST(req: Request, { params }: Params) {
  const { productId, projectId } = await params;
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
  let body: { sessionId?: unknown } = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
  }
  try {
    const project = getBoundEmbedProject(projectId, productId, auth.identity.user.id);
    const { token, expiresAt } = openEmbedProject(
      project,
      auth.identity.product,
      auth.identity.user,
      auth.identity.apiKey,
    );
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    const url = `${requestOrigin(req)}/embed/p/${encodeURIComponent(project.id)}${query}#token=${encodeURIComponent(token)}&expires=${expiresAt}`;
    return withEmbedCors(
      req,
      auth.identity.product,
      NextResponse.json(
        {
          project: {
            id: project.id,
            name: project.name,
            mode: project.mode,
            configUpdateAvailable: embedConfigUpdateAvailable(project, auth.identity.product),
          },
          token,
          expiresAt,
          url,
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    const response = NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
    return withEmbedCors(req, auth.identity.product, response);
  }
}
