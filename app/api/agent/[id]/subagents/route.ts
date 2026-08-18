import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
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
    const sessionFile = await resolveSessionPath(id);
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
