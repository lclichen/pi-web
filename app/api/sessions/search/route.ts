import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { requireUserIdentity } from "@/lib/web-session";
import { spaceForRequest } from "@/lib/session-spaces";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  const identity = requireUserIdentity(request);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401, headers });
  try {
    // Paths come only from the same catalog used by the sidebar. `allowStale`
    // keeps the request off the catalogue rebuild path: agent activity
    // invalidates the scan constantly, and rebuilding it costs hundreds of
    // milliseconds because loadAllSessions() re-reads every forked and subagent
    // session. The trade-off is that a session created in the last couple of
    // seconds is not searched yet; the stale read schedules the rebuild, so the
    // next search sees it.
    const space = spaceForRequest(identity.session, new URL(request.url).searchParams);
    const sessions = query && !request.signal.aborted
      ? await listAllSessions(space, { allowStale: true })
      : [];
    // Side chats stay in the search: lib/session-search.ts only reads what follows
    // their boundary message, so inherited history is not duplicated from the parent.
    return NextResponse.json(await searchSessionContents(sessions, query, request.signal), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
