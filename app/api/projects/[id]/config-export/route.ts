import { NextResponse } from "next/server";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { bundleDownloadResponse, exportProjectConfigBundle } from "@/lib/project-config-bundle";
import { isBundleLocked } from "@/lib/apkg";

export const dynamic = "force-dynamic";

// GET /api/projects/:id/config-export — download a shareable zip of the
// project's configuration (.pi/ minus credentials + labs/). Homes imported
// from an encrypted .apkg carry .pi/.bundle-lock.json and refuse re-export.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const project = getOwnedProject(id, identity.session.user.id);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  try {
    const home = ensureProjectHome(project);
    if (isBundleLocked(home)) {
      return NextResponse.json(
        { error: "该项目的配置来自加密配置包（.apkg），不允许再导出" },
        { status: 403 },
      );
    }
    const { bytes } = await exportProjectConfigBundle(home, project.name);
    const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_").trim() || "project";
    return bundleDownloadResponse(bytes, `${safeName}-config.zip`);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
