import { NextResponse } from "next/server";
import { AgentUnavailableError, relayRpc } from "@/lib/relay/forward";
import { defaultMachineForUser, recordPtyOwner } from "@/lib/relay/registry";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/terminal/create  { shell?, cwd?, cols?, rows? }
// Ask the agent to start an interactive PTY and return its session id. The
// browser then subscribes to .../terminal/[sid]/events for output.
export async function POST(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine — agent uses defaults
  }
  // Optional machine selection (multi-machine); validated so a bogus id cannot
  // be used as a map key.
  const machineId =
    typeof body.machineId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.machineId)
      ? body.machineId
      : undefined;
  if (machineId) delete body.machineId;
  try {
    const data = await relayRpc("pty.create", body, { userId: identity.session.user.id, machineId }) as { sessionId?: unknown };
    // Track ownership so the per-sid routes can authorize input/output access.
    if (data && typeof data.sessionId === "string") {
      recordPtyOwner(data.sessionId, identity.session.user.id, machineId ?? defaultMachineForUser(identity.session.user.id));
    }
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
