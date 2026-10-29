import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { addApkgKey, listApkgKeys, removeApkgKey } from "@/lib/apkg";
import { resolveApkgTool } from "@/lib/apkg-open";

export const dynamic = "force-dynamic";

/**
 * .apkg 解密密钥（KEK）管理 — 只写不可读：
 *
 *   GET    /api/admin/apkg-keys          仅元数据（keyId/来源/添加人/时间）+ 组件状态
 *   POST   /api/admin/apkg-keys          { keyId, kek } 添加或轮换（base64/hex，32 字节）
 *   DELETE /api/admin/apkg-keys?keyId=   吊销（移除文件库条目；env 提供的拒绝）
 *
 * 密钥本体只存在 <dataDir>/apkg-keys.json（0600），任何一个响应都不会带回
 * KEK；GET 也刻意不返回部分指纹（避免离线猜测）。PI_WEB_APKG_KEYS 提供的
 * keyId 优先于文件库，管理面不可覆盖/删除，只能改部署环境变量。
 */
function adminGuard(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return { error: NextResponse.json({ error: "Untrusted API request" }, { status: 403 }) } as const;
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return {
      error: NextResponse.json(
        { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
        { status: identity.status },
      ),
    } as const;
  }
  return { session: identity.session } as const;
}

export async function GET(req: Request) {
  const guard = adminGuard(req);
  if ("error" in guard) return guard.error;
  try {
    return NextResponse.json({
      keys: listApkgKeys(),
      tool: {
        path: resolveApkgTool(),
        // Explicitly configured path is authoritative (broken path surfaces at
        // import time instead of silently falling back to PATH).
        configured: Boolean(process.env.PI_WEB_APKG_TOOL),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Accept base64 (44 chars w/ padding) or hex (64 chars) for a 32-byte KEK. */
function decodeKek(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  // Base64url and standard base64 both decode; validate length, not charset.
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(normalized, "base64");
  return buf.length === 32 ? buf : null;
}

export async function POST(req: Request) {
  const guard = adminGuard(req);
  if ("error" in guard) return guard.error;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { keyId?: unknown; kek?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.keyId !== "string" || !KEY_ID_PATTERN.test(body.keyId)) {
    return NextResponse.json({ error: "keyId 需为 1-64 位字母/数字/._-（示例：prod-2026-10）" }, { status: 400 });
  }
  if (typeof body.kek !== "string" || body.kek.trim().length === 0) {
    return NextResponse.json({ error: "缺少密钥（kek）" }, { status: 400 });
  }
  const kek = decodeKek(body.kek);
  if (!kek) {
    return NextResponse.json({ error: "密钥格式无效：需要 32 字节 KEK（base64 或 64 位 hex）" }, { status: 400 });
  }
  try {
    const key = addApkgKey(body.keyId, kek, guard.session.user.username);
    // Echo metadata only — never the material.
    return NextResponse.json({ success: true, key }, { status: 201 });
  } catch (err) {
    const code = err instanceof Error ? err.message : String(err);
    if (code === "env-sourced") {
      return NextResponse.json(
        { error: "该 keyId 由部署环境变量 PI_WEB_APKG_KEYS 提供，优先级高于文件库；请在部署侧修改" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: code }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const guard = adminGuard(req);
  if ("error" in guard) return guard.error;
  const keyId = new URL(req.url).searchParams.get("keyId") ?? "";
  try {
    removeApkgKey(keyId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : String(err);
    if (code === "not-found") return NextResponse.json({ error: "密钥不存在" }, { status: 404 });
    if (code === "env-not-removable") {
      return NextResponse.json(
        { error: "该 keyId 由部署环境变量提供，不能在此删除；请在部署侧修改 PI_WEB_APKG_KEYS" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
