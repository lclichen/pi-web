import { NextResponse } from "next/server";
import { createProject, deleteProject, listProjects, updateProject, allProjects } from "@/lib/projects";
import { platformGet } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { provisionContainerForProject } from "@/lib/platform/provision";

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
  let body: { name?: unknown; mode?: unknown; containerId?: unknown; seedFromProjectId?: unknown; imageId?: unknown; workspaceId?: unknown; workdir?: unknown };
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
    ...(typeof body.imageId === "number" ? { imageId: body.imageId } : {}),
    ...(typeof body.seedFromProjectId === "string" ? { seedFromProjectId: body.seedFromProjectId } : {}),
    ...(typeof body.workdir === "string" && body.workdir ? { workdir: body.workdir } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // 沙箱项目：显式传入 containerId = 复用已有容器（保留环境）。校验归属
  // （平台按凭证过滤，只能看到自己的容器）与排他性（不得绑到其他项目）。
  if (result.project.mode === "sandbox" && typeof body.containerId === "number" && body.containerId > 0) {
    try {
      if (!identity.session.apiKey) throw new Error("沙箱模式需要平台凭证，请重新登录");
      const list = await platformGet<{ containers: Array<{ id: number; status: string }> }>(
        "/api/v1/containers",
        identity.session.apiKey,
        { filter: "all" },
      );
      const target = (list.containers ?? []).find((c) => c.id === body.containerId);
      if (!target) throw new Error("容器不存在或不属于你");
      if (target.status === "destroyed") throw new Error("该容器已销毁，无法绑定");
      const taken = allProjects().find(
        (p) => p.mode === "sandbox" && p.id !== result.project.id && Number(p.containerId) === body.containerId,
      );
      if (taken) throw new Error(`该容器已绑定到项目「${taken.name}」`);
      const updated = updateProject(result.project.id, { containerId: body.containerId });
      if (!updated.ok) throw new Error(updated.error);
      return NextResponse.json({ project: updated.project }, { status: 201 });
    } catch (error) {
      deleteProject(result.project.id);
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  // 沙箱项目：没有指定容器时自动创建/恢复一个并绑定（"跟随平台默认" 不再
  // 留下空项目——容器供给失败会立即报错并回滚，避免会话阶段静默失败）。
  if (result.project.mode === "sandbox" && result.project.containerId === undefined) {
    try {
      if (!process.env.PI_WEB_PLATFORM_URL) {
        throw new Error("沙箱模式未配置（缺少 PI_WEB_PLATFORM_URL）");
      }
      if (!identity.session.apiKey) {
        throw new Error("沙箱模式需要平台凭证，请重新登录");
      }
      // 别绑定已被其他项目占用的容器（两个项目共享一个容器会互相覆盖 /workspace）。
      const excluded = allProjects()
        .filter((p) => p.mode === "sandbox" && p.id !== result.project.id && p.containerId !== undefined && p.containerId !== null)
        .map((p) => Number(p.containerId));
      const provisioned = await provisionContainerForProject(
        identity.session.apiKey,
        result.project.name,
        excluded,
        {
          // 环境与云盘初始化来自创建对话框的选择（imageId 必须与项目一致；
          // workspaceId 只在创建新容器时生效，一次性 seed）。
          ...(typeof body.imageId === "number" ? { imageId: body.imageId } : {}),
          ...(typeof body.workspaceId === "number" ? { workspaceId: body.workspaceId } : {}),
        },
      );
      const updated = updateProject(result.project.id, { containerId: provisioned.containerId });
      if (!updated.ok) throw new Error(updated.error);
      return NextResponse.json({ project: updated.project }, { status: 201 });
    } catch (error) {
      deleteProject(result.project.id);
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  return NextResponse.json({ project: result.project }, { status: 201 });
}
