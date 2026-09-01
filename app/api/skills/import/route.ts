import { NextResponse } from "next/server";
import { resolveConfigCwdSync } from "@/lib/config-cwd";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { importSkillsZip } from "@/lib/project-config-bundle";

export const dynamic = "force-dynamic";

// POST /api/skills/import — multipart upload of a skills zip, unpacked into
// <cwd>/.pi/skills/ (offline skill sharing; skills.sh installs are the
// online counterpart via /api/skills/install).
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });

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
    const stats = await importSkillsZip(dir.cwd, data, file.name);
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
