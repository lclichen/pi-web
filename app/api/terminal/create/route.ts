import { NextResponse } from "next/server";
import { createLocalTerminal } from "@/lib/local-terminal";

export const dynamic = "force-dynamic";

// POST /api/terminal/create { cwd, cols?, rows?, shell? } — spawn a PTY on the
// pi-web server host in the workspace directory. Mirrors the agent-relay
// terminal create route's response shape.
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  if (!cwd) return NextResponse.json({ error: "Missing cwd" }, { status: 400 });
  try {
    const { sessionId, shell } = await createLocalTerminal({
      cwd,
      cols: typeof body.cols === "number" ? body.cols : undefined,
      rows: typeof body.rows === "number" ? body.rows : undefined,
      shell: typeof body.shell === "string" ? body.shell : undefined,
    });
    return NextResponse.json({ success: true, data: { sessionId, shell: shell.label } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
