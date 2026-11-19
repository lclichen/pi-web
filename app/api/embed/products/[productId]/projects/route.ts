import { NextResponse } from "next/server";
import { getEmbedProfile } from "@/lib/embed-profiles";
import { requireEmbedProductIdentity } from "@/lib/embed-product-auth";
import {
  createOrReuseEmbedProject,
  embedConfigUpdateAvailable,
  embedProjectView,
  EmbedWorkspaceError,
  listEmbedProjects,
} from "@/lib/embed-workspaces";
import { embedCorsPreflight, isEmbedOriginAllowed, withEmbedCors } from "@/lib/embed-cors";
import { isApiRequestHostAllowed } from "@/lib/request-security";
import { requestOrigin } from "@/lib/request-origin";
import { ProjectConfigLockBusyError } from "@/lib/project-config-lock";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string }> };

function errorResponse(req: Request, error: unknown, productId: string): NextResponse {
  const product = getEmbedProfile(productId);
  // 配置包写入共享写锁被其他进程占用 → 409（与应用中一致）。
  if (error instanceof ProjectConfigLockBusyError) {
    const busy = NextResponse.json({ error: error.message, code: "PROJECT_LOCKED" }, { status: 409 });
    return product ? withEmbedCors(req, product, busy) : busy;
  }
  const status = error instanceof EmbedWorkspaceError ? error.status : 500;
  const body =
    error instanceof EmbedWorkspaceError
      ? { error: error.message, ...(error.code ? { code: error.code } : {}) }
      : { error: error instanceof Error ? error.message : String(error) };
  const response = NextResponse.json(body, { status });
  return product ? withEmbedCors(req, product, response) : response;
}

export async function OPTIONS(req: Request, { params }: Params) {
  const { productId } = await params;
  const product = getEmbedProfile(productId);
  if (!product || !product.enabled) return new NextResponse(null, { status: 404 });
  return embedCorsPreflight(req, product);
}

// GET /api/embed/products/:productId/projects?clientId=
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
  const clientId = new URL(req.url).searchParams.get("clientId") ?? undefined;
  const projects = listEmbedProjects(productId, auth.identity.user.id, clientId).map((project) =>
    embedProjectView(project, auth.identity.product),
  );
  return withEmbedCors(
    req,
    auth.identity.product,
    NextResponse.json({ projects }, { headers: { "Cache-Control": "no-store" } }),
  );
}

// POST /api/embed/products/:productId/projects
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
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return withEmbedCors(
      req,
      auth.identity.product,
      NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    );
  }
  try {
    const result = await createOrReuseEmbedProject({
      product: auth.identity.product,
      user: auth.identity.user,
      apiKey: auth.identity.apiKey,
      body,
    });
    const view = embedProjectView(result.project, auth.identity.product);
    return withEmbedCors(
      req,
      auth.identity.product,
      NextResponse.json(
        {
          project: view,
          reused: result.reused,
          embedUrl: `${requestOrigin(req)}/embed/p/${encodeURIComponent(result.project.id)}`,
          configUpdateAvailable: embedConfigUpdateAvailable(result.project, auth.identity.product),
        },
        { status: result.reused ? 200 : 201, headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (error) {
    return errorResponse(req, error, productId);
  }
}
