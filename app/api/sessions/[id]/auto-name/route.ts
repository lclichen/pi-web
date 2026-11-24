import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { restoreSessionOptions, SessionRestoreError } from "@/lib/session-restore-options";
import { invalidateSessionListForSession } from "@/lib/session-reader";
import { resolveSessionAccess } from "@/lib/session-access";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const startedAt = Date.now();
  let phase: "restore" | "title" = "restore";

  try {
    const access = await resolveSessionAccess(req, id);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const filePath = access.path;
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const wasLive = Boolean(existing?.isAlive());
    const { session } = wasLive
      ? { session: existing! }
      : await startRpcSession(id, filePath, undefined, await restoreSessionOptions(req, id));

    // Title generation only needs the model + transcript. Extension binding
    // (MCP servers, remote channels) runs in parallel and can dominate the
    // first click on a cold session; waiting for it made auto-name look like a
    // timeout, while the second click hit the already-warm session. Wait only
    // briefly and never fail the title because a project extension is slow.
    const ready = session.waitUntilReady?.();
    if (ready) {
      await Promise.race([
        ready.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }

    phase = "title";
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListForSession(filePath);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 10_000) {
      console.warn(`[pi-web] auto-name slow: ${id.slice(0, 13)} took ${elapsedMs}ms (warm=${wasLive})`);
    }
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-web] auto-name failed after ${Date.now() - startedAt}ms (${phase}): ${message}`);
    return NextResponse.json(
      { error: message },
      { status: error instanceof SessionRestoreError ? error.status : 500 },
    );
  }
}
