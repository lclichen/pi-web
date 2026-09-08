import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { spaceForRequest } from "@/lib/session-spaces";
import { requireUserIdentity } from "@/lib/web-session";
import { searchSessionContents } from "@/lib/session-search";

export const dynamic = "force-dynamic";

// GET /api/sessions/search?q=… — full-text search over the CALLER's sessions.
// MERGE-NOTE(upgrade/0.9): upstream scans the global catalogue; this fork
// shards sessions per user space, so the search rides the same fence as
// /api/sessions (match snippets must never cross users).
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });

  const searchParams = new URL(req.url).searchParams;
  const query = (searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same per-space catalogue used by the sidebar.
    const space = spaceForRequest(identity.session, searchParams);
    const sessions = query && !req.signal.aborted ? await listAllSessions(space) : [];
    return NextResponse.json(await searchSessionContents(sessions, query, req.signal), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
