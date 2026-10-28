import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** 非管理员视角：剥除所有 provider 的 apiKey（凭据不出服务端），
 *  并标记 canEdit=false 供前端只读渲染。 */
function redactForUser(config: Record<string, unknown>): Record<string, unknown> {
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return { ...config, canEdit: false };
  }
  const redacted = Object.fromEntries(
    Object.entries(providers as Record<string, unknown>).map(([name, provider]) => {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [name, provider];
      const { apiKey: _drop, ...rest } = provider as Record<string, unknown>;
      return [name, rest];
    }),
  );
  return { ...config, providers: redacted, canEdit: false };
}

export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const config = readModelsConfig();
  // 管理员拿完整配置（含密钥，编辑需要）；普通用户脱敏——模型页只读展示，
  // 网关凭据不得下发到非管理员客户端（2026-10-26 审计修复）。
  if (identity.session.user.role === "admin") {
    return NextResponse.json({ ...config, canEdit: true });
  }
  return NextResponse.json(redactForUser(config));
}

export async function PUT(req: Request) {
  // Rewrites the GLOBAL models.json (every session's default provider list) —
  // admin only, same rule as global plugins/agents/mcp.
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "全局模型配置仅管理员可修改" }, { status: 403 });
  }
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
