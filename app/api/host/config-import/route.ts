import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { importProjectConfigBundle, MAX_IMPORT_BYTES } from "@/lib/project-config-bundle";

export const dynamic = "force-dynamic";

// POST /api/host/config-import?cwd=<server directory> — multipart upload of a
// config zip applied additively into that directory (.pi/, labs/). Host-mode
// counterpart of the per-project import; admin-only, root-fenced.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可用（Host 模式）" }, { status: 403 });
  }

  const cwd = new URL(req.url).searchParams.get("cwd") ?? "";
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return NextResponse.json({ error: "目录不存在" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRootsForRequest(req))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

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
    const stats = await importProjectConfigBundle(cwd, data);
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
