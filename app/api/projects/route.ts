import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/projects — the caller's projects, sorted by creation time.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json({ projects: listProjects(identity.session.user.id) });
}

// POST /api/projects { name, mode, containerId?, seedFromProjectId? }
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
    return NextResponse.json({ error: "项目需要登录（多用户模式）" }, { status: 400 });
  }
  if (identity.session.user.role !== "admin" && identity.session.user.role !== "user") {
    return NextResponse.json({ error: "无权创建项目" }, { status: 403 });
  }
  let body: { name?: unknown; mode?: unknown; containerId?: unknown; seedFromProjectId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const result = createProject({
    name: typeof body.name === "string" ? body.name : "",
    ownerId: identity.session.user.id,
    ownerName: identity.session.user.username,
    mode: typeof body.mode === "string" ? body.mode : "",
    ...(typeof body.containerId === "number" ? { containerId: body.containerId } : {}),
    ...(typeof body.seedFromProjectId === "string" ? { seedFromProjectId: body.seedFromProjectId } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ project: result.project }, { status: 201 });
}
