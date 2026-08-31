import { NextResponse } from "next/server";
import { ensureProjectHome, getOwnedProject } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { importProjectConfigBundle, MAX_IMPORT_BYTES } from "@/lib/project-config-bundle";

export const dynamic = "force-dynamic";

// POST /api/projects/:id/config-import — multipart upload of a config zip.
// Applied additively: same-named files overwrite, everything else is kept.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const project = getOwnedProject(id, identity.session.user.id);
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "无法解析上传内容（需要 multipart 表单）" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少上传文件（字段名 file）" }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "上传文件为空" }, { status: 400 });
  if (file.size > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: `配置包过大（>${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB）` }, { status: 413 });
  }

  try {
    const data = Buffer.from(await file.arrayBuffer());
    const home = ensureProjectHome(project);
    const stats = await importProjectConfigBundle(home, data);
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
