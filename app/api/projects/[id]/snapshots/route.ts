import { NextResponse } from "next/server";
import { platformDelete, platformGet, platformPost } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";
import { getOwnedProject, updateProject } from "@/lib/projects";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_SLOTS = 2;

interface PlatformSnapshot {
  id: number;
  name: string;
  size_bytes: number;
  created_at: string;
  container_id: number | null;
  container_status: string | null;
  image_name: string | null;
}

// GET /api/projects/[id]/snapshots — the project's save slots, reconciled
// against the platform's snapshot rows (the project record is bookkeeping;
// the platform is the source of truth).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { id } = await ctx.params;
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project || project.mode !== "sandbox") return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  try {
    const list = await platformGet<{ snapshots: PlatformSnapshot[] }>(
      "/api/v1/snapshots",
      identity.session.apiKey,
    );
    const mine = (list.snapshots ?? []).filter(
      (s) => project.snapshotSlots?.some((slot) => slot.id === s.id) ?? false,
    );
    return NextResponse.json({ snapshots: mine, containerId: project.containerId ?? null });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// POST /api/projects/[id]/snapshots
//   { action: "save" }                     — snapshot the project's container
//                                            into a slot (game-save FIFO ≤2)
//   { action: "restore", snapshotId }      — in-place restore, or into a NEW
//                                            container when the old one is gone
//   { action: "delete", snapshotId }       — drop one save slot
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { id } = await ctx.params;
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project || project.mode !== "sandbox") return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  let body: { action?: unknown; snapshotId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const apiKey = identity.session.apiKey;

  try {
    if (body.action === "save") {
      if (!project.containerId) throw new Error("项目没有绑定容器");
      const name = `${project.name.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 40)}-${Date.now().toString(36)}`;
      const created = await platformPost<{ id: number }>(
        `/api/v1/containers/${project.containerId}/snapshots`,
        apiKey,
        { name },
      );
      // Game-save FIFO: newest first, evict (and delete on the platform) the
      // oldest slot beyond the limit.
      const slots = [{ id: created.id, name, createdAt: Date.now() }, ...(project.snapshotSlots ?? [])];
      const evicted = slots.splice(MAX_SLOTS);
      updateProject(project.id, { snapshotSlots: slots });
      for (const slot of evicted) {
        await platformDelete(`/api/v1/snapshots/${slot.id}`, apiKey).catch(() => {});
      }
      return NextResponse.json({ success: true, snapshotId: created.id, evicted: evicted.map((s) => s.id) });
    }

    if (body.action === "restore") {
      if (typeof body.snapshotId !== "number") throw new Error("snapshotId required");
      let newContainerId = project.containerId ?? null;
      if (newContainerId) {
        // In-place restore (container still exists — platform requires it stopped;
        // it handles stop/copy/start internally).
        await platformPost(`/api/v1/containers/${newContainerId}/snapshots/${body.snapshotId}/restore`, apiKey);
      } else {
        // The container was recycled: materialize a brand-new one from the
        // save point and rebind the project to it.
        const created = await platformPost<{ id: number }>(
          `/api/v1/snapshots/${body.snapshotId}/restore-container`,
          apiKey,
          { name: `rc-${project.name.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 30)}` },
        );
        newContainerId = created.id;
        const updated = updateProject(project.id, { containerId: newContainerId });
        if (!updated.ok) throw new Error(updated.error);
        return NextResponse.json({ success: true, containerId: newContainerId, rebound: true });
      }
      return NextResponse.json({ success: true, containerId: newContainerId });
    }

    if (body.action === "delete") {
      if (typeof body.snapshotId !== "number") throw new Error("snapshotId required");
      await platformDelete(`/api/v1/snapshots/${body.snapshotId}`, apiKey);
      updateProject(project.id, {
        snapshotSlots: (project.snapshotSlots ?? []).filter((s) => s.id !== body.snapshotId),
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: `不支持的操作: ${String(body.action)}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
