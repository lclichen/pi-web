import { NextResponse } from "next/server";
import { createRemoteTerminal } from "@/lib/remote-terminal";
import { resolveRemoteSession } from "@/lib/remote-session";

export const dynamic = "force-dynamic";

// POST /api/remoteterminal/create { sessionId, cols?, rows? } — open a shell
// on the session's remote backend (platform container / the user's machine).
export async function POST(req: Request) {
  let body: { sessionId?: unknown; cols?: unknown; rows?: unknown };
  try {
    body = (await req.json()) as { sessionId?: unknown; cols?: unknown; rows?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.sessionId !== "string") {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  const remote = await resolveRemoteSession(req, body.sessionId);
  if (!remote.ok) return NextResponse.json({ error: remote.error }, { status: remote.status });
  try {
    const { sessionId } = await createRemoteTerminal(remote.ctx, {
      cols: typeof body.cols === "number" ? body.cols : 80,
      rows: typeof body.rows === "number" ? body.rows : 24,
    });
    return NextResponse.json({ success: true, data: { sessionId } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
