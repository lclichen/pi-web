import { NextResponse } from "next/server";
import { AgentUnavailableError, relayRpc } from "@/lib/relay/forward";
import { requireUserIdentity } from "@/lib/web-session";
import type { RpcMethod } from "@/lib/relay/protocol";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/rpc  { method, params? }
// Forwards a one-shot JSON-RPC call to the connected Local Agent. Returns the
// same { success, data } / { error } envelope used by /api/agent/[id] so the
// browser's existing error handling (lib/relay-client.ts) applies unchanged.
export async function POST(req: Request) {
  let body: { method?: unknown; params?: unknown };
  try {
    body = (await req.json()) as { method?: unknown; params?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  const method = body.method as RpcMethod;
  if (typeof method !== "string") {
    return NextResponse.json({ error: "missing 'method'" }, { status: 400 });
  }
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : undefined;

  try {
    const data = await relayRpc(method, params, { userId: identity.session.user.id });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
