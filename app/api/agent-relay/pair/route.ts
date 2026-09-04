import { NextResponse } from "next/server";
import { createPairingCode } from "@/lib/relay/registry";
import { getRelayInfo } from "@/lib/relay/ws-server";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/pair
// Mint a one-time pairing code. The browser shows the code + an install/run
// command for the user to execute on their local (e.g. CentOS 7) machine.
export async function POST(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  let label: string | undefined;
  try {
    const body = (await req.json()) as { label?: unknown };
    if (typeof body.label === "string" && body.label.trim()) label = body.label.trim().slice(0, 50);
  } catch {
    // no body / not JSON — pairing without a pre-chosen label is fine
  }
  // The pairing code binds the connecting agent to the minting user.
  const pc = createPairingCode(identity.session.user.id, label);
  const relay = getRelayInfo();
  return NextResponse.json(
    {
      code: pc.code,
      expiresAt: pc.expiresAt,
      relayPort: relay.port,
      // When pi-web sits behind a reverse proxy, set PI_RELAY_ADVERTISE_URL so
      // the command shown to users points at the externally-reachable address.
      advertiseUrl: process.env.PI_RELAY_ADVERTISE_URL ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
