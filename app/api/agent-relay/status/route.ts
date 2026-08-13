import { NextResponse } from "next/server";
import { getStatus } from "@/lib/relay/registry";
import { getRelayInfo } from "@/lib/relay/ws-server";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/status
// Lightweight snapshot for polling: is a Local Agent connected, and what does
// the browser know about it (hostname/os/workspaceRoot)? Also returns the relay
// port so the UI can build the `pi-agent pair --server …` command.
export async function GET() {
  const relay = getRelayInfo();
  return NextResponse.json(
    {
      ...getStatus(),
      relayPort: relay.port,
      advertiseUrl: process.env.PI_RELAY_ADVERTISE_URL ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
