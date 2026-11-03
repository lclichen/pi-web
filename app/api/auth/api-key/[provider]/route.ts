import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType, storeProviderCredential } from "@/lib/provider-credential-store";
import { requireUserIdentity } from "@/lib/web-session";
import { credentialAuthPath } from "@/lib/user-models";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

/**
 * Provider 凭据的写入位置按角色分 scope：
 *   · admin  → 全局 `~/.pi/agent/auth.json`（所有用户默认使用）
 *   · 普通用户 → `<dataDir>/user-models/u<id>/auth.json`（只影响自己）
 * 普通用户绝不能改全局凭据（2026-11-03 P0 修复）。
 */
async function scopedAuthPath(req: Request): Promise<
  { ok: true; authPath: string } | { ok: false; response: NextResponse }
> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return { ok: false, response: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  }
  const { user } = identity.session;
  return { ok: true, authPath: credentialAuthPath(user.id, user.role === "admin") };
}

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { provider } = await params;
  const scope = await scopedAuthPath(req);
  if (!scope.ok) return scope.response;
  try {
    const { apiKey } = (await req.json()) as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    const modelRuntime = await ModelRuntime.create({ authPath: scope.authPath });
    const apiKeyAuth = modelRuntime.getProvider(provider)?.auth.apiKey;
    if (!apiKeyAuth?.login) {
      throw new Error(`${provider} does not support API key login`);
    }
    let keySubmitted = false;
    const credential = await apiKeyAuth.login({
      signal: req.signal,
      notify: () => {},
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          const keyOption = prompt.options.find((option) => option.id === "api-key" || option.id === "bearer-token");
          if (keyOption) return keyOption.id;
          throw new Error(`${provider} requires interactive authentication setup`);
        }
        if (!keySubmitted && prompt.type === "secret") {
          keySubmitted = true;
          return apiKey.trim();
        }
        throw new Error(`${provider} requires additional authentication settings`);
      },
    });
    // ModelRuntime.login() persists the credential and then performs an
    // unbounded network catalog refresh. Store the returned credential
    // directly so a slow catalog cannot leave the save request hanging.
    await storeProviderCredential(provider, credential, scope.authPath);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key (caller scope only)
export async function DELETE(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { provider } = await params;
  const scope = await scopedAuthPath(req);
  if (!scope.ok) return scope.response;
  try {
    const removal = await removeStoredCredentialIfType(provider, "api_key", scope.authPath);
    if (removal.status === "type_mismatch") {
      return NextResponse.json({ error: `${provider} is authenticated with OAuth, not an API key` }, { status: 409 });
    }
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
