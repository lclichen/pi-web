import { NextResponse } from "next/server";
import { getOwnedProject, projectHome } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { workspaceDescriptor } from "@/lib/workspace-key";
import { loadProjectionManifest } from "@/lib/projection/manifest";
import { readProjectionStatus } from "@/lib/projection/status";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/projects/:id/projection — last downlink reconcile + dirty list.
export async function GET(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const descriptor = workspaceDescriptor(project);
  const manifest = loadProjectionManifest(project.id, descriptor.key);
  const status = readProjectionStatus(project.id, descriptor.key);
  return NextResponse.json({
    ok: true,
    projectId: project.id,
    hostHome: projectHome(project),
    workspaceKey: descriptor.key,
    workspace: { mode: descriptor.mode, root: descriptor.root, backend: descriptor.backend },
    fileCount: manifest ? Object.keys(manifest.files).length : 0,
    hostDigest: manifest?.hostDigest ?? "",
    last: status,
    dirty: status?.dirty ?? [],
    conflicts: status?.conflicts ?? [],
    errors: status?.errors ?? [],
    truncated: status?.truncated ?? null,
    lastVerifiedAt: status?.lastVerifiedAt ?? null,
  });
}
