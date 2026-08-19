import { NextResponse } from "next/server";
import { closeRemoteTerminal } from "@/lib/remote-terminal";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  closeRemoteTerminal(sid);
  return NextResponse.json({ success: true });
}
