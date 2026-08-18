import { NextResponse } from "next/server";
import { resizeLocalTerminal } from "@/lib/local-terminal";

export const dynamic = "force-dynamic";

// POST /api/terminal/[sid]/resize { cols, rows } — propagate terminal size to
// the PTY so full-screen programs redraw correctly.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ sid: string }> },
): Promise<Response> {
  const { sid } = await ctx.params;
  let body: { cols?: unknown; rows?: unknown };
  try {
    body = (await req.json()) as { cols?: unknown; rows?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cols = typeof body.cols === "number" ? body.cols : NaN;
  const rows = typeof body.rows === "number" ? body.rows : NaN;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return NextResponse.json({ error: "cols and rows must be numbers" }, { status: 400 });
  }
  resizeLocalTerminal(sid, cols, rows);
  return NextResponse.json({ success: true });
}
