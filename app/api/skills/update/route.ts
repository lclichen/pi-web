import { NextResponse } from "next/server";
import { runNpx } from "@/lib/npx";
import type { SkillInstallScope } from "@/lib/api-types";
import { buildSkillUpdateArgs } from "@/lib/skill-updates";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { requireUserIdentity } from "@/lib/web-session";
import { isUserScopedConfig, userConfigDir } from "@/lib/user-config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      cwd?: unknown;
      package?: unknown;
      scope?: unknown;
    };
    const identity = requireUserIdentity(req);
    if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
    const userId = identity.session.user.id;
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const pkg = typeof body.package === "string" ? body.package : "";
    const scope =
      body.scope === "global" || body.scope === "user" || body.scope === "project"
        ? (body.scope as SkillInstallScope)
        : undefined;
    if (!cwd || !pkg || !scope) {
      return NextResponse.json({ error: "cwd, package, and scope are required" }, { status: 400 });
    }
    if (scope === "global" && identity.session.user.id !== 0 && identity.session.user.role !== "admin") {
      return NextResponse.json({ error: "全局技能仅管理员可更新" }, { status: 403 });
    }
    if (scope === "user" && !isUserScopedConfig(userId)) {
      return NextResponse.json({ error: "用户技能需要登录用户" }, { status: 403 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { skills } = await loadSkillsWithInstallInfo(cwd, userId);
    const skill = skills.find((item) => item.install?.package === pkg && item.install.scope === scope);
    if (!skill?.install) {
      return NextResponse.json({ error: "Installed skill not found" }, { status: 404 });
    }
    if (!skill.install.canCheckForUpdates) {
      return NextResponse.json({ error: "This skill cannot be updated automatically" }, { status: 400 });
    }

    const { stdout, stderr } = await runNpx(buildSkillUpdateArgs(skill.install), {
      timeout: 60_000,
      cwd: scope === "project" ? cwd : scope === "user" && isUserScopedConfig(userId) ? userConfigDir(userId) : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const refreshed = await loadSkillsWithInstallInfo(cwd, userId);
    const updatedSkill = refreshed.skills.find((item) => item.install?.package === pkg && item.install.scope === scope);
    return NextResponse.json({
      success: true,
      skill: updatedSkill,
      output: `${stdout}${stderr}`.slice(-500),
    });
  } catch (error: unknown) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
    return NextResponse.json({ error: output || detail.message || String(error) }, { status: 500 });
  }
}
