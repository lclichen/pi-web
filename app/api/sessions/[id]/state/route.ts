import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionAccess } from "@/lib/session-access";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const access = await resolveSessionAccess(_req, id);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    if (!access.path) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const rpc = getRpcSession(id);
    if (!rpc?.isAlive()) return NextResponse.json({ running: false });

    const state = await rpc.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
