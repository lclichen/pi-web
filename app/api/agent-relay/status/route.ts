import { NextResponse } from "next/server";
import { getStatusForUser } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";
import { getRelayInfo } from "@/lib/relay/ws-server";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/status
// Lightweight snapshot for polling: is a Local Agent connected, and what does
// the browser know about it (hostname/os/workspaceRoot)? Also returns the relay
// port so the UI can build the `pi-agent pair --server …` command.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const status = getStatusForUser(identity.session.user.id);
  const relay = getRelayInfo();
  return NextResponse.json(
    {
      ...status,
      relayPort: relay.port,
      advertiseUrl: process.env.PI_RELAY_ADVERTISE_URL ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
