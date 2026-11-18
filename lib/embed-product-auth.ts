import { platformKeyFrom, resolvePlatformUser } from "./batch/batch-auth.ts";
import { requireUserIdentity, type PlatformUser } from "./web-session.ts";
import { getEmbedProfile, isProductMember } from "./embed-profiles.ts";
import type { EmbedProductProfile } from "./embed-types.ts";

export interface EmbedProductIdentity {
  user: PlatformUser;
  apiKey: string;
  product: EmbedProductProfile;
}

export type EmbedProductAuthResult =
  | { ok: true; identity: EmbedProductIdentity }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Product API authentication: long-lived user platform API key (preferred) or
 * a same-origin web cookie for debugging. The product profile's members list
 * is the authoritative product permission.
 */
export async function requireEmbedProductIdentity(
  req: Request,
  productId: string,
): Promise<EmbedProductAuthResult> {
  let user: PlatformUser | null = null;
  let apiKey = "";
  const key = platformKeyFrom(req);
  if (key) {
    user = await resolvePlatformUser(key);
    apiKey = key;
    if (!user) return { ok: false, status: 401, error: "Invalid or inactive platform API key" };
  } else {
    const identity = requireUserIdentity(req);
    if (!identity.ok) return { ok: false, status: identity.status, error: "登录已失效" };
    user = identity.session.user;
    apiKey = identity.session.apiKey;
  }

  const product = getEmbedProfile(productId);
  if (!product || !product.enabled) return { ok: false, status: 404, error: "产品不存在或未启用" };
  if (!isProductMember(product, user.id)) {
    return { ok: false, status: 403, error: "当前用户不在该产品的用户组中", code: "not_member" };
  }
  return { ok: true, identity: { user, apiKey, product } };
}
