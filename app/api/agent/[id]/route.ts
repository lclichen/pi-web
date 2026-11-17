import { NextResponse } from "next/server";
import { checkLiveSessionAccess, resolveSessionAccess, sessionOwnerInfo } from "@/lib/session-access";
import { startRpcSession, getRpcSession, setRpcSessionTools, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { restoreSessionOptions } from "@/lib/session-restore-options";
import { requireUserIdentity } from "@/lib/web-session";
import { hasAdminTakeover, isReadOnlyAgentCommand } from "@/lib/admin-takeover";
import {
  isEmbedCommandAllowed,
  normalizeEmbedCommandName,
  slashCommandNameFromText,
} from "@/lib/embed-commands";

/** Keep the product's command palette and the actual command surface aligned. */
function filterEmbedCommandResult(result: unknown, allowedCommands: string[]): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { commands?: unknown }).commands)) {
    return result;
  }
  const commands = (result as { commands: unknown[] }).commands.filter((command) => {
    if (!command || typeof command !== "object") return false;
    const name = (command as { name?: unknown }).name;
    return typeof name === "string" && isEmbedCommandAllowed(allowedCommands, name);
  });
  return { ...result, commands };
}

/**
 * A slash prompt may name a command that the product does not expose. The
 * client hides/blocks known commands, but direct API callers are checked here
 * against the session's registered command list. Non-command slash text such
 * as "/tmp/file" is left alone.
 */
async function embedPromptCommandDenied(
  session: AgentSessionWrapper,
  body: { type?: unknown; message?: unknown },
  allowedCommands: string[],
): Promise<string | null> {
  if (body.type !== "prompt" || typeof body.message !== "string") return null;
  const name = slashCommandNameFromText(body.message);
  if (!name || isEmbedCommandAllowed(allowedCommands, name)) return null;
  if (session.isRunning()) return null;
  try {
    const probe = (await session.send({ type: "get_commands" })) as {
      commands?: Array<{ name?: unknown }>;
    } | null;
    const target = normalizeEmbedCommandName(name);
    const known = (probe?.commands ?? []).some(
      (command) =>
        typeof command?.name === "string" && normalizeEmbedCommandName(command.name) === target,
    );
    return known ? `命令 /${name} 未对当前产品开放` : null;
  } catch {
    // Probe failure should not turn arbitrary slash-prefixed text into a 403.
    return null;
  }
}

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
    const embed = identity.ok ? identity.session.embed : undefined;
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
      if (embed) {
        const denied = await embedPromptCommandDenied(existing, body, embed.allowedCommands);
        if (denied) return NextResponse.json({ error: denied, code: "embed_command_denied" }, { status: 403 });
      }
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({
        success: true,
        data: embed && body.type === "get_commands" ? filterEmbedCommandResult(result, embed.allowedCommands) : result,
      });
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
    if (embed) {
      const denied = await embedPromptCommandDenied(session, body, embed.allowedCommands);
      if (denied) return NextResponse.json({ error: denied, code: "embed_command_denied" }, { status: 403 });
    }
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({
      success: true,
      data: embed && body.type === "get_commands" ? filterEmbedCommandResult(result, embed.allowedCommands) : result,
    });
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
