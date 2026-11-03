import { NextResponse } from "next/server";
import { checkLiveSessionAccess } from "@/lib/session-access";
import { getRpcSession } from "@/lib/rpc-manager";
import { acquireSessionLivenessLease, renewSessionLivenessLeases } from "@/lib/session-liveness";

// POST /api/agent/[id]/lease - Renew the selected session's liveness lease.
// The page calls this every 30s while the session is selected, even when the
// agent is idle; each renewal resets the session's idle countdown so an open
// tab keeps the wrapper (and any background task) alive. A page whose SSE
// stream is closed (idle session) gets a lease here instead; it expires 90s
// after the page stops renewing. Unknown ids answer 200 without creating one.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Live sessions are served from the in-memory registry; the ownership fence
  // prevents another logged-in user from keeping someone else's session warm.
  const fence = checkLiveSessionAccess(req, id);
  if (!fence.ok) return NextResponse.json({ error: fence.error }, { status: fence.status });

  let renewed = renewSessionLivenessLeases(id);
  let created = false;
  if (renewed === 0 && (getRpcSession(id)?.isAlive() ?? false)) {
    // No stream lease yet: create a page lease. Its TTL releases it if the
    // page disappears; the next POST finds and renews it.
    acquireSessionLivenessLease(id);
    renewed = 1;
    created = true;
  }

  return NextResponse.json(
    { success: true, renewed, ...(created ? { created } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
