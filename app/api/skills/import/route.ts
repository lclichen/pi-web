import { NextResponse } from "next/server";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveConfigCwdSync } from "@/lib/config-cwd";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { importSkillsZip } from "@/lib/project-config-bundle";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { isUserScopedConfig, userSkillsDir } from "@/lib/user-config";

export const dynamic = "force-dynamic";

// POST /api/skills/import?scope=project|user|global — multipart upload of a
// skills zip. Project scope unpacks into <cwd>/.pi/skills/; user scope into
// the caller's user-config/u<id>/skills; global (admin only) into
// <agentDir>/skills. Skills.sh/SkillHub installs are the online counterpart.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const scope =
    searchParams.get("scope") === "global"
      ? "global"
      : searchParams.get("scope") === "user"
        ? "user"
        : "project";
  if (scope === "global" && identity.session.user.id !== 0 && identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "全局技能仅管理员可上传" }, { status: 403 });
  }
  if (scope === "user" && !isUserScopedConfig(identity.session.user.id)) {
    return NextResponse.json({ error: "用户技能需要登录用户" }, { status: 403 });
  }
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
  if (scope === "project" && !getProjectTrustStatus(dir.cwd, getAgentDir()).trusted) {
    return NextResponse.json(
      { error: "Project resources must be trusted before importing project skills" },
      { status: 403 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "无法解析上传内容（需要 multipart 表单）" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "缺少上传文件（字段名 file）" }, { status: 400 });
  }
  if (file.size > 200 * 1024 * 1024) {
    return NextResponse.json({ error: "技能包过大（>200MB）" }, { status: 413 });
  }

  try {
    const data = Buffer.from(await file.arrayBuffer());
    const skillsRoot =
      scope === "global"
        ? join(getAgentDir(), "skills")
        : scope === "user"
          ? userSkillsDir(identity.session.user.id)
          : undefined;
    const stats = await importSkillsZip(dir.cwd, data, file.name, skillsRoot ? { skillsRoot } : undefined);
    return NextResponse.json({ ok: true, scope, ...stats });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
