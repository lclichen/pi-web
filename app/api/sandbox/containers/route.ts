import { NextResponse } from "next/server";
import { platformGet } from "@/lib/platform/client";
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

interface ProvisionDefaults {
  imageId: number;
  imageName: string;
  workspaceId: number | null;
  workspaceName: string | null;
}

// GET /api/sandbox/containers — running containers + provisioning defaults
// for the calling user's sandbox sessions (BFF: their platform API key).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (!identity.session.apiKey) {
    return NextResponse.json({ error: "缺少平台凭证，请重新登录" }, { status: 401 });
  }
  try {
    const [listRes, defaults] = await Promise.all([
      platformGet<{ containers: PlatformContainer[] }>(
        "/api/v1/containers",
        identity.session.apiKey,
        { filter: "running" },
      ),
      platformGet<ProvisionDefaults>("/api/v1/provision/defaults", identity.session.apiKey).catch(() => null),
    ]);
    return NextResponse.json({
      success: true,
      containers: (listRes.containers ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
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

// POST /api/sandbox/containers { containerId: number | null }
// Pin (or clear) the default container for the user's sandbox sessions —
// written into their stub-home sandbox-platform.json.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.id === 0) {
    return NextResponse.json({ error: "沙箱模式需要登录" }, { status: 400 });
  }
  let body: { containerId?: unknown };
  try {
    body = (await req.json()) as { containerId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.containerId !== null && typeof body.containerId !== "number") {
    return NextResponse.json({ error: "containerId must be a number or null" }, { status: 400 });
  }
  setSandboxContainer(identity.session.user.id, body.containerId as number | null);
  return NextResponse.json({ success: true });
}
