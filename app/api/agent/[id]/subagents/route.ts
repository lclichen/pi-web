import { NextResponse } from "next/server";
import { resolveSessionAccess } from "@/lib/session-access";
import { findSubagentSessions, readSubagentRecords } from "@/lib/subagent-records";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/subagents — finished subagent history for one session:
// `subagents:record` entries from the session file (absolute timestamps) plus
// the session ids of persisted subagent conversations for replay.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const access = await resolveSessionAccess(_req, id);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const sessionFile = access.path;
    if (!sessionFile) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const records = await readSubagentRecords(sessionFile);
    // Newest first.
    records.sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0));
    const sessions = await findSubagentSessions(id, records);
    return NextResponse.json({ records, sessions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
