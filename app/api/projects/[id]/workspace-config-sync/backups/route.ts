import { NextResponse } from "next/server";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listWorkspaceConfigBackups } from "@/lib/sync-backups";

export const dynamic = "force-dynamic";

// GET /api/projects/:id/workspace-config-sync/backups — recent applies that
// can be rolled back (newest first).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  return NextResponse.json({ backups: listWorkspaceConfigBackups(ensureProjectHome(project)) });
}
