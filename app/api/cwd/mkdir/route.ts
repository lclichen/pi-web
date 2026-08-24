import { NextResponse } from "next/server";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import { stat } from "fs/promises";
import { normalizeDirectory } from "@/lib/directory-browser";
import { requireUserIdentity } from "@/lib/web-session";

// POST /api/cwd/mkdir  body: { path: string }
// Creates a single directory at the given absolute path (used by the
// directory picker's "新建文件夹"). The parent must already exist — no
// recursive creation, so a typo surfaces as an error instead of a deep tree.
// Host-space write: restricted to admins (host identity in single-user mode).
export async function POST(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "无权创建目录" }, { status: 403 });
  }

  try {
    const body = await req.json() as { path?: unknown };
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!rawPath) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const target = normalizeDirectory(rawPath);
    // 校验父目录存在，避免误建深层目录。
    let parentOk = true;
    try {
      const parentStat = await stat(dirname(target));
      parentOk = parentStat.isDirectory();
    } catch {
      parentOk = false;
    }
    if (!parentOk) {
      return NextResponse.json({ error: `父目录不存在：${dirname(target)}` }, { status: 400 });
    }
    try {
      await stat(target);
      return NextResponse.json({ error: `目录已存在：${target}` }, { status: 400 });
    } catch {
      // 不存在 → 可以创建
    }

    await mkdir(target);
    return NextResponse.json({ success: true, path: target });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
