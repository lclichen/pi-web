import { NextResponse } from "next/server";
import { authorizeRemoteTerminal, closeRemoteTerminal } from "@/lib/remote-terminal";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  const auth = authorizeRemoteTerminal(req, sid);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  closeRemoteTerminal(sid);
  return NextResponse.json({ success: true });
}
