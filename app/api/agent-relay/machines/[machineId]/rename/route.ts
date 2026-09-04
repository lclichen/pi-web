import { NextResponse } from "next/server";
import { getMachinesForUser } from "@/lib/relay/registry";
import { renameAgentMachine } from "@/lib/relay/relay-store";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// POST /api/agent-relay/machines/[machineId]/rename { label }
// Rename one of the caller's paired machines. Labels are cosmetic but also
// drive the project machine selector, so keep them short and unique-ish.
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
  let body: { label?: unknown };
  try {
    body = (await req.json()) as { label?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 50) : "";
  if (!label) return NextResponse.json({ error: "标签不能为空" }, { status: 400 });

  // Ownership: the machine must be among the caller's paired machines.
  const owned = getMachinesForUser(identity.session.user.id).some((m) => m.machineId === machineId);
  if (!owned) return NextResponse.json({ error: "机器不存在" }, { status: 404 });

  try {
    await renameAgentMachine(identity.session.user.id, machineId, label);
  } catch {
    return NextResponse.json({ error: "机器不存在" }, { status: 404 });
  }
  return NextResponse.json({ machines: getMachinesForUser(identity.session.user.id) });
}
