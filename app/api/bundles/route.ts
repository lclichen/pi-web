import { NextResponse } from "next/server";
import JSZip from "jszip";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listBundles, isValidBundleName, saveBundle } from "@/lib/config-bundles-store";

export const dynamic = "force-dynamic";

const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

// GET /api/bundles — list preset config bundles (any authenticated user; the
// wizard offers them at project creation).
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json({ bundles: listBundles() });
}

// POST /api/bundles — admin upload: multipart file=<zip>, name, description.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可管理配置模板" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "无法解析上传内容（需要 multipart 表单）" }, { status: 400 });
  }
  const file = form.get("file");
  const rawName = String(form.get("name") ?? "");
  const description = String(form.get("description") ?? "");
  const name = (rawName.trim() || (file instanceof File ? file.name.replace(/\.zip$/i, "") : "")).trim();
  if (!isValidBundleName(name)) {
    return NextResponse.json({ error: "模板名只能包含字母、数字、点、下划线、连字符（≤64 字符）" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "缺少上传文件（字段名 file）" }, { status: 400 });
  }
  if (file.size > MAX_BUNDLE_BYTES) {
    return NextResponse.json({ error: "模板包过大（>200MB）" }, { status: 413 });
  }
  // Zip integrity check before storing.
  try {
    await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "无法解析压缩包（需要 zip 格式）" }, { status: 400 });
  }

  const data = Buffer.from(await file.arrayBuffer());
  saveBundle(name, description, data);
  return NextResponse.json({ ok: true, name, size: data.length }, { status: 201 });
}
