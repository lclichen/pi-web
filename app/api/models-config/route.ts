import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  clearUserModelConfig,
  effectiveModelsConfig,
  hasUserModelOverride,
  writeUserModels,
} from "@/lib/user-models";

export const dynamic = "force-dynamic";

/**
 * 模型配置的读写 scope：
 *   · admin  → 全局层 `~/.pi/agent/models.json`（所有用户默认使用）
 *   · user   → 自己的层 `<dataDir>/user-models/u<id>/models.json`（只影响自己）
 *
 * 普通用户 GET 看到的是「全局 + 用户」合并后的**有效配置**（便于在全局模型
 * 基础上增改），但所有 apiKey 都会剥除（全局密钥绝不下发；用户自己的密钥
 * 是 write-only，通过 /api/auth/* 管理）。PUT 只保存与全局不同的 provider，
 * 避免把全局配置快照进用户层。
 */
function redactApiKeys(config: Record<string, unknown>): Record<string, unknown> {
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return config;
  const redacted = Object.fromEntries(
    Object.entries(providers as Record<string, unknown>).map(([name, provider]) => {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [name, provider];
      const { apiKey: _drop, ...rest } = provider as Record<string, unknown>;
      return [name, rest];
    }),
  );
  return { ...config, providers: redacted };
}

export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;

  if (user.role === "admin") {
    return NextResponse.json({
      ...readModelsConfig(),
      canEdit: true,
      scope: "global",
    });
  }

  return NextResponse.json({
    ...redactApiKeys(effectiveModelsConfig(user.id)),
    canEdit: true,
    scope: "user",
    hasUserOverride: hasUserModelOverride(user.id),
  });
}

export async function PUT(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;
    // Defensive: drop UI-only fields if an older client still sends them.
    const { canEdit: _canEdit, scope: _scope, hasUserOverride: _hasUserOverride, ...clean } = body;
    if (identity.session.user.role === "admin") {
      // 全局层：所有用户默认使用。
      writeModelsConfig(clean);
      return NextResponse.json({ success: true, scope: "global" });
    }
    // 用户层：只影响自己；与全局相同的 provider 会被省略。
    writeUserModels(identity.session.user.id, clean);
    invalidateModelsCache();
    return NextResponse.json({ success: true, scope: "user" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** DELETE：普通用户清空自己的模型覆盖（回到全局）；管理员不允许删全局。 */
export async function DELETE(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role === "admin") {
    return NextResponse.json({ error: "全局模型配置不支持整体删除" }, { status: 400 });
  }
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  clearUserModelConfig(identity.session.user.id);
  invalidateModelsCache();
  return NextResponse.json({ success: true, scope: "global" });
}
