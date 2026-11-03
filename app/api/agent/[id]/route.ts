import { NextResponse } from "next/server";
import { checkLiveSessionAccess, resolveSessionAccess, sessionOwnerInfo } from "@/lib/session-access";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { restoreSessionOptions } from "@/lib/session-restore-options";
import { requireUserIdentity } from "@/lib/web-session";
import { hasAdminTakeover, isReadOnlyAgentCommand } from "@/lib/admin-takeover";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = (await req.json()) as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined &&
      (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // 管理员支持视图：默认只读。运行中会话的归属可见；写入类命令需要显式
    // 接管（POST /api/sessions/:id/takeover），避免"点进去就改了别人的会话"。
    const identity = requireUserIdentity(req);
    if (identity.ok) {
      const caller = identity.session.user;
      if (caller.role === "admin" && caller.id !== 0 && !isReadOnlyAgentCommand(commandType ?? "")) {
        const live = getRpcSession(id)?.isAlive() ?? false;
        const owner = sessionOwnerInfo(id);
        if (live && owner.ownerId > 0 && owner.ownerId !== caller.id && !hasAdminTakeover(id, caller.id)) {
          return NextResponse.json(
            {
              error: `该会话归属 ${owner.ownerName ?? `用户 #${owner.ownerId}`}，管理员支持视图为只读；如需写入，请先点击“接管”。`,
              code: "read_only",
              ...(owner.ownerName ? { ownerName: owner.ownerName } : {}),
            },
            { status: 403 },
          );
        }
      }
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      // Live sessions are served from the registry (no file path to fence), so
      // ownership must be checked explicitly: owner or admin only.
      const fence = checkLiveSessionAccess(req, id);
      if (!fence.ok) return NextResponse.json({ error: fence.error }, { status: fence.status });
    }
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
      return NextResponse.json(
        {
          error: "Session not found",
          ...(body.type === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
        },
        { status: 404 },
      );
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
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        ...(commandType === "prompt" && !promptAccepted ? { code: "prompt_rejected", accepted: false } : {}),
      },
      { status: 500 },
    );
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }
    // Registry hit: check ownership explicitly (owner or admin only).
    const fence = checkLiveSessionAccess(req, id);
    if (!fence.ok) return NextResponse.json({ error: fence.error }, { status: fence.status });

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
