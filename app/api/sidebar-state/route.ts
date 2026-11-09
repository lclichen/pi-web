import { NextResponse } from "next/server";
import { listProjects, updateProject } from "@/lib/projects";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { isSidebarProjectKey, type SidebarPinState } from "@/lib/sidebar-state-shared";
import { readSidebarPins, setPinnedProject, setPinnedSession } from "@/lib/sidebar-state";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

/**
 * GET   /api/sidebar-state                 → { pinnedProjects, pinnedSessions }
 * PATCH /api/sidebar-state { projectKey, pinned } | { sessionId, pinned }
 *
 * Pins cover platform projects and Host directories alike. Legacy
 * ProjectRecord.pinnedSessions are merged into the response and cleared when
 * that session is unpinned.
 */
function effectivePins(userId: number): SidebarPinState {
  const pins = readSidebarPins(userId);
  const seen = new Set(pins.pinnedSessions);
  const pinnedSessions = [...pins.pinnedSessions];
  for (const project of listProjects(userId)) {
    for (const sessionId of project.pinnedSessions) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      pinnedSessions.push(sessionId);
    }
  }
  return { pinnedProjects: pins.pinnedProjects, pinnedSessions };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  return NextResponse.json(effectivePins(identity.session.user.id));
}

export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  const body = (await req.json().catch(() => ({}))) as {
    projectKey?: unknown;
    sessionId?: unknown;
    pinned?: unknown;
  };
  if (typeof body.pinned !== "boolean") {
    return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400 });
  }
  const projectKey = typeof body.projectKey === "string" ? body.projectKey.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if ((projectKey ? 1 : 0) + (sessionId ? 1 : 0) !== 1) {
    return NextResponse.json({ error: "projectKey or sessionId required" }, { status: 400 });
  }
  if (projectKey && (!isSidebarProjectKey(projectKey) || projectKey.length > 4096)) {
    return NextResponse.json({ error: "invalid projectKey" }, { status: 400 });
  }
  if (sessionId && sessionId.length > 256) {
    return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
  }

  const userId = identity.session.user.id;
  if (projectKey) {
    setPinnedProject(userId, projectKey, body.pinned);
  } else {
    setPinnedSession(userId, sessionId, body.pinned);
    // Legacy per-project pins are the same user-visible state: unpinning must
    // clear them too, or the next GET would bring the session back.
    if (!body.pinned) {
      for (const project of listProjects(userId)) {
        if (project.pinnedSessions.includes(sessionId)) {
          updateProject(project.id, { unpinSessionId: sessionId });
        }
      }
    }
  }
  return NextResponse.json(effectivePins(userId));
}
