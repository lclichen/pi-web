import { NextResponse } from "next/server";
import { listProjects } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { workspaceDescriptor } from "@/lib/workspace-key";
import { loadProjectionManifest } from "@/lib/projection/manifest";
import { isProjectionDirty } from "@/lib/projection/reconcile";
import { projectionBadgeSummary, readProjectionStatus } from "@/lib/projection/status";

export const dynamic = "force-dynamic";

// GET /api/projection-statuses — compact per-project projection state for the
// sidebar badges. Only projects that have reconciled at least once appear.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  const statuses: Record<string, ReturnType<typeof projectionBadgeSummary>> = {};
  for (const project of listProjects(identity.session.user.id)) {
    const descriptor = workspaceDescriptor(project);
    const status = readProjectionStatus(project.id, descriptor.key);
    const pending = isProjectionDirty(project.id);
    if (!status && !pending) continue;
    const manifest = loadProjectionManifest(project.id, descriptor.key);
    statuses[project.id] = projectionBadgeSummary(
      status,
      manifest ? Object.keys(manifest.files).length : 0,
      pending,
    );
  }
  return NextResponse.json({ statuses });
}
