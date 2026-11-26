import { NextResponse } from "next/server";
import { getProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/:id/machine — 本人本机模式项目的机器绑定（machineId /
 * workdir / previousMachineId）。
 *
 * `workdir` 被 publicProject() 有意剥掉（那是用户机器上的绝对路径，embed
 * token 与跨用户响应都不能带），但「重新连接机器」对话框需要显示/编辑本项
 * 目自己的目录，所以单开这个接口。
 *
 * 归属语义与 getOwnedProject 对齐：auth-off 的隐式 host 身份（userId 0）本来
 * 就能读写任意项目（单用户、无隔离需求；部署从多用户切回 auth-off 后，旧项目
 * 的 ownerId 仍可能非 0），所以这里对 0 放行。但**不**继承 admin 分支：auth-on
 * 时 admin 也读不到别人项目的 workdir（机器路径不因管理权限而跨用户暴露）。
 */
export async function GET(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { id } = await ctx.params;
  const project = getProject(id);
  const userId = identity.session.user.id;
  if (!project || (project.ownerId !== userId && userId !== 0)) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  if (project.mode !== "local-machine") {
    return NextResponse.json({ error: "仅本机模式项目有机器绑定" }, { status: 400 });
  }
  return NextResponse.json({
    machineId: project.machineId ?? null,
    ...(project.previousMachineId ? { previousMachineId: project.previousMachineId } : {}),
    workdir: project.workdir ?? "",
  });
}
