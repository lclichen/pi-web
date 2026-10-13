import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { apkgKeysStorePath, createApkgKeyGeneration, listApkgKeyIds } from "@/lib/apkg-keys";

export const dynamic = "force-dynamic";

// GET /api/apkg/keys — 列出密钥代（仅 id 与仓路径；密钥材料永不离开服务端）。
// POST /api/apkg/keys { keyId? } — 新建一代（id ≤16 字节，缺省日期+随机）。
// 均为发布方（管理员）工具；auth-off 单机模式按隐式 host 管理员放行。
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员（发布方）可用" }, { status: 403 });
  }
  const storePath = apkgKeysStorePath();
  return NextResponse.json({ storePath, keys: listApkgKeyIds(storePath) });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员（发布方）可用" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { keyId?: unknown };
  const keyId = typeof body.keyId === "string" && body.keyId.trim() ? body.keyId.trim() : undefined;
  try {
    const created = createApkgKeyGeneration(apkgKeysStorePath(), keyId);
    return NextResponse.json({ keyId: created.keyId, storePath: apkgKeysStorePath() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
