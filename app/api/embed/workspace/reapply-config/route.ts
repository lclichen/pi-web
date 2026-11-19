import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { getProject } from "@/lib/projects";
import { getEmbedProfile } from "@/lib/embed-profiles";
import { reapplyEmbedConfig } from "@/lib/embed-workspaces";
import { ProjectConfigLockBusyError } from "@/lib/project-config-lock";

export const dynamic = "force-dynamic";

// POST /api/embed/workspace/reapply-config — explicit product-config refresh
// from the embed page (access token). Applies the product's fixed bundle.
export async function POST(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const embed = identity.session.embed;
  if (!embed) return NextResponse.json({ error: "Access token required" }, { status: 401 });
  const project = getProject(embed.scope.projectId);
  if (!project || project.ownerId !== identity.session.user.id || !project.embed) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  const product = getEmbedProfile(project.embed.productId);
  if (!product || product.id !== embed.productId) {
    return NextResponse.json({ error: "产品不存在或未启用" }, { status: 404 });
  }
  try {
    const view = await reapplyEmbedConfig(project, product);
    return NextResponse.json({ project: view }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // 配置包写入共享写锁被其他进程占用 → 409（与项目配置写路由一致）。
    if (error instanceof ProjectConfigLockBusyError) {
      return NextResponse.json({ error: error.message, code: "PROJECT_LOCKED" }, { status: 409 });
    }
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
