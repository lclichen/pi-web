import { NextResponse } from "next/server";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { applyBundleToDirectory, bundleExists, isValidBundleName } from "@/lib/config-bundles-store";
import { withProjectConfigWriteLock, ProjectConfigLockBusyError } from "@/lib/project-config-lock";

export const dynamic = "force-dynamic";

// POST /api/projects/:id/apply-bundle { name } — apply a preset config
// bundle (admin-managed template) to an EXISTING project. Same additive
// semantics as config-import (same-named files overwrite, rest is kept);
// the template stays in the store, the project gets its content.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const project = getOwnedProject(id, identity.session.user.id);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  if (!isValidBundleName(name) || !bundleExists(name)) {
    return NextResponse.json({ error: `配置模板不存在：${name}` }, { status: 400 });
  }

  try {
    const home = ensureProjectHome(project);
    // 项目 home 配置写入走共享写锁（ADR-0004 §4.2），与 sync apply/rollback、
    // 项目 PATCH 等互斥，避免并发读到混合版本。
    await withProjectConfigWriteLock(project.id, async () => {
      await applyBundleToDirectory(name, home);
    });
    return NextResponse.json({ ok: true, name });
  } catch (e) {
    if (e instanceof ProjectConfigLockBusyError) {
      return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
