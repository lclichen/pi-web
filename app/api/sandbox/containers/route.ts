import { NextResponse } from "next/server";
import { platformDelete, platformGet, platformPost } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";
import { setSandboxContainer } from "@/lib/mode-homes";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

interface PlatformContainer {
  id: number;
  name: string;
  status: string;
  image_id: number;
  cpu?: number;
  memory_mb?: number;
  disk_gb?: number;
  image_name?: string;
  created_at?: string;
}

export interface PlatformSnapshot {
  id: number;
  name: string;
  description?: string | null;
  created_at?: string;
}

interface PlatformImage {
  id: number;
  name: string;
  display_name: string;
  default_resources?: { cpu: number; memoryMb: number; diskGb: number } | null;
}

interface ProvisionDefaults {
  imageId: number;
  imageName: string;
  workspaceId: number | null;
  workspaceName: string | null;
}

/** BFF guard: sandbox management requires a logged-in platform user with a key. */
async function requireSandboxUser(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { error: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) } as const;
  if (!identity.session.apiKey) {
    return { error: NextResponse.json({ error: "缺少平台凭证，请重新登录" }, { status: 401 }) } as const;
  }
  return { apiKey: identity.session.apiKey, userId: identity.session.user.id } as const;
}

// GET /api/sandbox/containers — the user's containers in ALL states (for the
// management panel) + public images (create dialog) + provisioning defaults.
// ?containerId=N additionally returns that container's snapshots (the dialog
// loads them lazily when a row is expanded).
export async function GET(req: Request) {
  const guard = await requireSandboxUser(req);
  if ("error" in guard) return guard.error;
  const snapshotFor = Number(new URL(req.url).searchParams.get("containerId"));
  try {
    const [listRes, imagesRes, defaults, snapshotsRes] = await Promise.all([
      platformGet<{ containers: PlatformContainer[] }>(
        "/api/v1/containers",
        guard.apiKey,
        { filter: "all" },
      ),
      platformGet<{ images: PlatformImage[] }>("/api/v1/images", guard.apiKey).catch(() => ({ images: [] as PlatformImage[] })),
      platformGet<ProvisionDefaults>("/api/v1/provision/defaults", guard.apiKey).catch(() => null),
      Number.isInteger(snapshotFor) && snapshotFor > 0
        ? platformGet<{ snapshots: PlatformSnapshot[] }>(`/api/v1/containers/${snapshotFor}/snapshots`, guard.apiKey).catch(() => null)
        : Promise.resolve(null),
    ]);
    return NextResponse.json({
      success: true,
      // "destroyed" rows are tombstones the platform keeps — hide them.
      containers: (listRes.containers ?? [])
        .filter((c) => c.status !== "destroyed")
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          imageId: c.image_id,
          imageName: c.image_name ?? "",
          cpu: c.cpu ?? null,
          memoryMb: c.memory_mb ?? null,
          diskGb: c.disk_gb ?? null,
          createdAt: c.created_at ?? null,
        })),
      images: (imagesRes.images ?? []).map((i) => ({
        id: i.id,
        name: i.display_name || i.name,
        defaultResources: i.default_resources ?? null,
      })),
      defaults,
      ...(snapshotsRes ? { snapshots: snapshotsRes.snapshots ?? [] } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

// POST /api/sandbox/containers
//   { containerId: number | null }              — legacy: pin/clear the user's default
//   { action: "create", imageId, name?, ... }   — create + connect a container
//   { action: "start" | "stop", containerId }   — lifecycle control
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  let body: {
    containerId?: unknown;
    action?: unknown;
    imageId?: unknown;
    name?: unknown;
    cpu?: unknown;
    memoryMb?: unknown;
    diskGb?: unknown;
    snapshotId?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Legacy shape: pin the default container for the user's stub home.
  if (body.action === undefined) {
    if (identity.session.user.id === 0) {
      return NextResponse.json({ error: "沙箱模式需要登录" }, { status: 400 });
    }
    if (body.containerId !== null && typeof body.containerId !== "number") {
      return NextResponse.json({ error: "containerId must be a number or null" }, { status: 400 });
    }
    setSandboxContainer(identity.session.user.id, body.containerId as number | null);
    return NextResponse.json({ success: true });
  }

  const guard = await requireSandboxUser(req);
  if ("error" in guard) return guard.error;
  const action = body.action;
  try {
    if (action === "create") {
      if (typeof body.imageId !== "number") {
        return NextResponse.json({ error: "imageId must be a number" }, { status: 400 });
      }
      const created = await platformPost<{ id: number; name: string }>(
        "/api/v1/containers",
        guard.apiKey,
        {
          imageId: body.imageId,
          // Platform requires a name (letters/digits/_/./space/- only).
          name:
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : `web-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
          ...(typeof body.cpu === "number" ? { cpu: body.cpu } : {}),
          ...(typeof body.memoryMb === "number" ? { memoryMb: body.memoryMb } : {}),
          ...(typeof body.diskGb === "number" ? { diskGb: body.diskGb } : {}),
        },
      );
      // Connect so the container registers a session and reports running.
      await platformPost(`/api/v1/containers/${created.id}/connect`, guard.apiKey).catch(() => null);
      return NextResponse.json({ success: true, container: created });
    }
    if (action === "start" || action === "stop") {
      if (typeof body.containerId !== "number") {
        return NextResponse.json({ error: "containerId must be a number" }, { status: 400 });
      }
      await platformPost(`/api/v1/containers/${body.containerId}/${action}`, guard.apiKey);
      return NextResponse.json({ success: true });
    }
    // Snapshots (restore points): create / restore / delete, scoped to the
    // caller's own container (platform enforces ownership too).
    if (action === "snapshot-create") {
      if (typeof body.containerId !== "number") {
        return NextResponse.json({ error: "containerId must be a number" }, { status: 400 });
      }
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : `snap-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
      await platformPost(`/api/v1/containers/${body.containerId}/snapshots`, guard.apiKey, { name });
      return NextResponse.json({ success: true });
    }
    if (action === "snapshot-restore" || action === "snapshot-delete") {
      if (typeof body.containerId !== "number" || typeof body.snapshotId !== "number") {
        return NextResponse.json({ error: "containerId and snapshotId must be numbers" }, { status: 400 });
      }
      if (action === "snapshot-restore") {
        await platformPost(`/api/v1/containers/${body.containerId}/snapshots/${body.snapshotId}/restore`, guard.apiKey);
      } else {
        await platformDelete(`/api/v1/containers/${body.containerId}/snapshots/${body.snapshotId}`, guard.apiKey);
      }
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: `不支持的操作: ${String(action)}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

// DELETE /api/sandbox/containers?containerId=N — destroy the user's container.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const guard = await requireSandboxUser(req);
  if ("error" in guard) return guard.error;
  const containerId = Number(new URL(req.url).searchParams.get("containerId"));
  if (!Number.isInteger(containerId) || containerId <= 0) {
    return NextResponse.json({ error: "containerId must be a positive integer" }, { status: 400 });
  }
  try {
    await platformDelete(`/api/v1/containers/${containerId}`, guard.apiKey);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
