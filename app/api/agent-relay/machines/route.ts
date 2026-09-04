import { NextResponse } from "next/server";
import { getMachinesForUser } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/machines — the caller's paired machines (online +
// offline), merged from live connections and persisted token metadata.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json(
    { machines: getMachinesForUser(identity.session.user.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
