import { NextResponse } from "next/server";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getProject } from "@/lib/projects";
import { getEmbedProfile, isProductMember } from "@/lib/embed-profiles";
import { resolvePlatformUser, platformKeyFrom } from "@/lib/batch/batch-auth";
import { openEmbedProject, embedConfigUpdateAvailable } from "@/lib/embed-workspaces";
import type { EmbedAuthResponse } from "@/lib/embed-types";

export const dynamic = "force-dynamic";

// POST /api/embed/auth — same-origin iframe API-key exchange. The API key can
// be supplied in the JSON body (auth gate) or as a platform-key header.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { projectId?: unknown; apiKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const apiKey =
    platformKeyFrom(req) ??
    (typeof body.apiKey === "string" && body.apiKey.trim().startsWith("sk_") ? body.apiKey.trim() : "");
  if (!apiKey) return NextResponse.json({ error: "API Key is required" }, { status: 401 });

  const user = await resolvePlatformUser(apiKey);
  if (!user) return NextResponse.json({ error: "API Key 无效或账号已停用" }, { status: 401 });

  const project = getProject(projectId);
  if (!project?.embed || project.ownerId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  const product = getEmbedProfile(project.embed.productId);
  if (!product || !product.enabled) return NextResponse.json({ error: "产品不存在或未启用" }, { status: 404 });
  if (!isProductMember(product, user.id)) {
    return NextResponse.json({ error: "当前用户不在该产品的用户组中" }, { status: 403 });
  }

  const { token, expiresAt } = openEmbedProject(project, product, user, apiKey);
  const response: EmbedAuthResponse = {
    token,
    expiresAt,
    user: { id: user.id, username: user.username },
    product: { id: product.id, name: product.name },
    project: { id: project.id, name: project.name, mode: project.mode },
    allowedCommands: [...product.allowedCommands],
    configUpdateAvailable: embedConfigUpdateAvailable(project, product),
  };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
