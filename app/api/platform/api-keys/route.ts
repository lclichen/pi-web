import { NextResponse } from "next/server";
import { platformGet, platformPost } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { vaultListApiKeys, vaultStoreApiKey } from "@/lib/api-key-vault";

export const dynamic = "force-dynamic";

/** 登录流程铸造的会话密钥命名约定（app/api/webauth/login）。 */
const AUTO_SESSION_KEY_NAME = /^pi-web \d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/platform/api-keys — 当前用户的平台个人密钥列表。
 * 明文字段只对"经 pi-web 创建"（保管文件在册）的密钥返回；平台侧直建的
 * 密钥只有前缀/元数据，UI 标注无法回显。
 * source 分组：manual=经此页创建（在册可回显）；auto=登录会话密钥
 * （pi-web YYYY-MM-DD 命名，登出/过期自动吊销）；external=平台侧直建。
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const session = identity.session;
  if (!session.apiKey) {
    return NextResponse.json({ error: "当前登录态没有平台凭证（免认证单机模式无法管理平台密钥）" }, { status: 400 });
  }
  try {
    const res = await platformGet<{ apiKeys?: PlatformKeyRow[] }>("/api/v1/auth/api-keys", session.apiKey);
    const vault = vaultListApiKeys(session.user.id);
    // 平台保留已吊销行作审计；列表只给有效密钥（吊销即从 UI 消失）。
    const keys = (res.apiKeys ?? [])
      .filter((row) => !row.revoked_at)
      .map((row) => {
        const plaintext = vault.get(String(row.id));
        const canReveal = Boolean(plaintext);
        return {
          id: row.id,
          name: row.name,
          keyPrefix: row.key_prefix,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
          ...(plaintext ? { key: plaintext } : {}),
          canReveal,
          source: canReveal ? ("manual" as const) : AUTO_SESSION_KEY_NAME.test(row.name) ? ("auto" as const) : ("external" as const),
          ...(String(row.id) === String(session.apiKeyId) ? { isCurrent: true } : {}),
        };
      });
    return NextResponse.json({ keys });
  } catch (e) {
    return NextResponse.json({ error: `平台请求失败: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

interface PlatformKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// POST /api/platform/api-keys { name } — 创建并保管明文（可重复回显）。
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const session = identity.session;
  if (!session.apiKey) {
    return NextResponse.json({ error: "当前登录态没有平台凭证（免认证单机模式无法管理平台密钥）" }, { status: 400 });
  }
  let name: unknown;
  try {
    ({ name } = await req.json() as { name?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof name !== "string" || !name.trim() || name.trim().length > 128) {
    return NextResponse.json({ error: "密钥名称必填（≤128 字符）" }, { status: 400 });
  }
  try {
    const created = await platformPost<PlatformKeyRow & { key: string }>(
      "/api/v1/auth/api-keys", session.apiKey, { name: name.trim() },
    );
    if (!created?.key?.startsWith("sk_")) {
      return NextResponse.json({ error: "平台返回的密钥格式异常" }, { status: 502 });
    }
    // 明文入保管——这是"可重复回显"的唯一来源，失败要显式暴露（密钥仍有效，
    // 用户这次能看到，但之后不可回显）。
    let vaulted = true;
    try {
      vaultStoreApiKey(session.user.id, created.id, created.name, created.key);
    } catch (e) {
      vaulted = false;
      console.error("[api-keys] 保管失败（本次返回明文，之后不可回显）:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({
      key: {
        id: created.id,
        name: created.name,
        keyPrefix: created.key_prefix,
        createdAt: created.created_at,
        lastUsedAt: created.last_used_at,
        revokedAt: created.revoked_at,
        key: created.key,
        canReveal: vaulted,
        source: "manual" as const,
      },
      vaulted,
    }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: `平台请求失败: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
