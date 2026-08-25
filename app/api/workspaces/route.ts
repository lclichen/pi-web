import { NextResponse } from "next/server";
import { platformGet, platformPost } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

interface PlatformWorkspace {
  id: number;
  name: string;
  description: string | null;
  is_template: boolean;
  created_at: string;
}

// GET /api/workspaces — the caller's cloud workspaces. Lazily ensures the
// per-user default workspace exists ("我的工作区" — one per user in v1).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (!identity.session.apiKey) {
    return NextResponse.json({ error: "缺少平台凭证，请重新登录" }, { status: 401 });
  }
  try {
    let list: PlatformWorkspace[];
    try {
      const res = await platformGet<{ workspaces: PlatformWorkspace[]; items?: PlatformWorkspace[] }>(
        "/api/v1/workspaces",
        identity.session.apiKey,
      );
      list = res.workspaces ?? res.items ?? [];
    } catch {
      list = [];
    }
    const normal = list.filter((w) => !w.is_template);
    if (normal.length === 0) {
      // Auto-create the user's default workspace on first use. The platform
      // schema only allows ASCII names; the UI renders the fixed label
      // "我的工作区" regardless of the stored name.
      const created = await platformPost<PlatformWorkspace>(
        "/api/v1/workspaces",
        identity.session.apiKey,
        { name: "my-workspace", description: "Cloud file storage (seeds /workspace when creating projects)" },
      );
      normal.push(created);
    }
    return NextResponse.json({ workspaces: normal });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
