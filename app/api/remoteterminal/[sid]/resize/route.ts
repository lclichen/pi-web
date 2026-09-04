import { NextResponse } from "next/server";
import { authorizeRemoteTerminal, resizeRemoteTerminal } from "@/lib/remote-terminal";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  const auth = authorizeRemoteTerminal(req, sid);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: { cols?: unknown; rows?: unknown };
  try {
    body = (await req.json()) as { cols?: unknown; rows?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.cols !== "number" || typeof body.rows !== "number") {
    return NextResponse.json({ error: "cols and rows must be numbers" }, { status: 400 });
  }
  resizeRemoteTerminal(sid, body.cols, body.rows);
  return NextResponse.json({ success: true });
}
