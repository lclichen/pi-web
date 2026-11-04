import { addSubscription, type PushSubscriptionRecord } from "@/lib/web-push";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

interface SubscribeRequestBody {
  subscription?: Partial<PushSubscriptionRecord>;
  locale?: string;
}

function isValidSubscription(
  subscription: Partial<PushSubscriptionRecord> | undefined,
): subscription is PushSubscriptionRecord {
  if (typeof subscription !== "object" || subscription === null) return false;
  if (typeof subscription.endpoint !== "string" || !/^https:\/\//.test(subscription.endpoint)) return false;
  const keys = subscription.keys;
  if (typeof keys !== "object" || keys === null) return false;
  return (
    typeof keys.p256dh === "string" && keys.p256dh.length > 0 && typeof keys.auth === "string" && keys.auth.length > 0
  );
}

// POST /api/push/subscribe - register a browser push subscription. Upserts by
// endpoint, so the client can safely re-send its subscription on every load.
export async function POST(req: Request): Promise<Response> {
  let body: SubscribeRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidSubscription(body.subscription)) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  const identity = requireUserIdentity(req);
  if (!identity.ok) return Response.json({ error: "登录已失效" }, { status: identity.status });
  const locale = body.locale === "zh-CN" ? "zh-CN" : "en";
  await addSubscription(
    {
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      locale,
    },
    identity.session.user.id,
  );
  return Response.json({ ok: true });
}
