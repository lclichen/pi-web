import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { requireUserIdentity } from "@/lib/web-session";
import { credentialAuthPath } from "@/lib/user-models";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * OAuth logout：只清调用者自己 scope 的凭据——管理员清全局，普通用户清自己的
 * `<dataDir>/user-models/u<id>/auth.json`（2026-11-03 P0 修复）。
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  }
  const { provider } = await params;
  const authPath = credentialAuthPath(identity.session.user.id, identity.session.user.role === "admin");
  try {
    const modelRuntime = await ModelRuntime.create({ authPath });
    if (!modelRuntime.getProvider(provider)?.auth.oauth) {
      return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
    }
    const removal = await removeStoredCredentialIfType(provider, "oauth", authPath);
    if (removal.status === "type_mismatch") {
      return NextResponse.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
    }
    invalidateModelsCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
