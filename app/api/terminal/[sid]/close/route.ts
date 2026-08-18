import { NextResponse } from "next/server";
import { closeLocalTerminal } from "@/lib/local-terminal";

export const dynamic = "force-dynamic";

// POST /api/terminal/[sid]/close — kill the PTY. Idempotent.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  closeLocalTerminal(sid);
  return NextResponse.json({ success: true });
}
