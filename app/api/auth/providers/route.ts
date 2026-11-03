import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { requireUserIdentity } from "@/lib/web-session";
import { ensureUserModelRuntime } from "@/lib/user-models";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
//
// 普通用户看「全局 + 用户」合并后的凭据状态（否则自己新存的 key 不显示为
// configured）；管理员看全局。这里只读状态，不下发密钥。
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  }
  const { user } = identity.session;
  const scoped = user.role === "admin" ? null : ensureUserModelRuntime(user.id);
  const modelRuntime = await ModelRuntime.create(scoped ? { authPath: scoped.authPath } : {});
  const inputs = await collectProviderListingInputs(modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
