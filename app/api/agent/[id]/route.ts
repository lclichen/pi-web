import { NextResponse } from "next/server";
import { resolveSessionAccess } from "@/lib/session-access";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { restoreSessionOptions } from "@/lib/session-restore-options";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      let filePath = existing?.sessionFile || undefined;
      if (!filePath) {
        // MERGE-NOTE(upgrade/0.84): upstream resolved the file from the global
        // host space; dev's per-user fence (resolveSessionAccess) applies instead.
        const access = await resolveSessionAccess(req, id);
        if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
        filePath = access.path ?? undefined;
      }
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const access = await resolveSessionAccess(req, id);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const filePath = access.path;
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    // Restored sessions must get the SAME mode extensions as new ones
    // (sandbox bridge / relay tools / remote-verify) — otherwise a restored
    // sandbox session runs as a bare local session and every tool executes
    // in the server-side project home. Upstream's toolNames selection rides
    // along on the same start options.
    const options = await restoreSessionOptions(req, id);
    const { session } = await startRpcSession(id, filePath, undefined, {
      ...options,
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
