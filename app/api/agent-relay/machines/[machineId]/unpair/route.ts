import { NextResponse } from "next/server";
import { disconnectMachine, getMachinesForUser } from "@/lib/relay/registry";
import { revokeAgentMachine } from "@/lib/relay/relay-store";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/machines/[machineId]/unpair
// Revoke the machine's token (it cannot reconnect) and drop its live socket.
// The owning user must confirm in the UI — running remote sessions on this
// machine lose their terminal/agent connection.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ machineId: string }> },
) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { machineId } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) {
    return NextResponse.json({ error: "无效的机器标识" }, { status: 400 });
  }

  const owned = getMachinesForUser(identity.session.user.id).some((m) => m.machineId === machineId);
  if (!owned) return NextResponse.json({ error: "机器不存在" }, { status: 404 });

  const revoked = await revokeAgentMachine(identity.session.user.id, machineId);
  const disconnected = disconnectMachine(identity.session.user.id, machineId);
  if (!revoked && !disconnected) {
    return NextResponse.json({ error: "机器不存在" }, { status: 404 });
  }
  return NextResponse.json({ machines: getMachinesForUser(identity.session.user.id) });
}
