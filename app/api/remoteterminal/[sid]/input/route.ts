import { NextResponse } from "next/server";
import { writeRemoteTerminal } from "@/lib/remote-terminal";

export const dynamic = "force-dynamic";

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
  writeRemoteTerminal(sid, body.data);
  return NextResponse.json({ success: true });
}
