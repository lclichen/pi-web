import { NextResponse } from "next/server";
import { createPairingCode } from "@/lib/relay/registry";
import { getRelayInfo } from "@/lib/relay/ws-server";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/pair
// Mint a one-time pairing code. The browser shows the code + an install/run
// command for the user to execute on their local (e.g. CentOS 7) machine.
export async function POST() {
  const pc = createPairingCode();
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
