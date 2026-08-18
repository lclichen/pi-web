import { NextResponse } from "next/server";
import { writeLocalTerminal } from "@/lib/local-terminal";

export const dynamic = "force-dynamic";

// POST /api/terminal/[sid]/input { data } — forward keystrokes to the PTY.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  let body: { data?: unknown };
  try {
    body = (await req.json()) as { data?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.data !== "string") {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }
  writeLocalTerminal(sid, body.data);
  return NextResponse.json({ success: true });
}
