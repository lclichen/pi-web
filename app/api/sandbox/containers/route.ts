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
export async function GET(req: Request) {
  const guard = await requireSandboxUser(req);
  if ("error" in guard) return guard.error;
  try {
    const [listRes, imagesRes, defaults] = await Promise.all([
      platformGet<{ containers: PlatformContainer[] }>(
        "/api/v1/containers",
        guard.apiKey,
        { filter: "all" },
      ),
      platformGet<{ images: PlatformImage[] }>("/api/v1/images", guard.apiKey).catch(() => ({ images: [] as PlatformImage[] })),
      platformGet<ProvisionDefaults>("/api/v1/provision/defaults", guard.apiKey).catch(() => null),
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
        })),
      images: (imagesRes.images ?? []).map((i) => ({
        id: i.id,
        name: i.display_name || i.name,
        defaultResources: i.default_resources ?? null,
      })),
      defaults,
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
