import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { requireUserIdentity } from "@/lib/web-session";
import { isSessionMode, modeAllowedForUser } from "@/lib/session-modes";
import { spaceDir } from "@/lib/session-spaces";
import { ensureSandboxHome, ensureLocalHome } from "@/lib/mode-homes";
import { recordSessionMeta } from "@/lib/session-metas";
import { makeRelayToolsExtension } from "@/lib/extensions/relay-tools";
import { getAgentForUser } from "@/lib/relay/registry";
import { isApiRequestAllowed } from "@/lib/request-security";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

// POST /api/agent/new  body: { cwd: string; mode?: "host"|"sandbox"|"local-machine"; type: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// With PI_WEB_AUTH=on the session is bound to the calling user's space and the
// requested execution mode (design doc §2/§4).
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;

  try {
    const body = await req.json() as { cwd?: string; mode?: unknown; [key: string]: unknown };
    const { cwd, ...command } = body;
    const rawMode = body.mode;
    const mode = rawMode === undefined ? "host" : (isSessionMode(rawMode) ? rawMode : null);
    if (!mode) {
      return NextResponse.json({ error: `Invalid mode: ${String(rawMode)}` }, { status: 400 });
    }
    const permission = modeAllowedForUser(mode, { id: user.id, role: user.role });
    if (!permission.ok) {
      return NextResponse.json({ error: permission.reason }, { status: 403 });
    }

    let effectiveCwd: string | undefined = typeof cwd === "string" ? cwd : undefined;
    let additionalExtensionPaths: string[] | undefined;
    let extensionFactories: InlineExtension[] | undefined;
    let sessionDir: string | undefined;

    if (mode === "sandbox") {
      if (!process.env.PI_WEB_PLATFORM_URL) {
        return NextResponse.json({ error: "沙箱模式未配置（缺少 PI_WEB_PLATFORM_URL）" }, { status: 400 });
      }
      if (user.id !== 0 && !identity.session.apiKey) {
        return NextResponse.json({ error: "沙箱模式需要平台凭证，请重新登录" }, { status: 401 });
      }
      const extPath = process.env.PI_WEB_SANDBOX_EXTENSION_PATH;
      if (!extPath || !existsSync(extPath)) {
        return NextResponse.json({ error: "沙箱模式未配置（PI_WEB_SANDBOX_EXTENSION_PATH 无效）" }, { status: 400 });
      }
      // Per-user stub home carries the sandbox config (url/apiKey/container/
      // disableLocalFallback) via <home>/.pi/sandbox-platform.json.
      effectiveCwd = ensureSandboxHome(user.id, {
        url: process.env.PI_WEB_PLATFORM_URL,
        apiKey: identity.session.apiKey,
        disableLocalFallback: true,
      });
      additionalExtensionPaths = [extPath];
    } else if (mode === "local-machine") {
      if (user.id !== 0 && !getAgentForUser(user.id)?.info) {
        return NextResponse.json({ error: "本机模式需要先配对你的电脑（本机面板 → 连接本机）" }, { status: 400 });
      }
      effectiveCwd = ensureLocalHome(user.id);
      extensionFactories = [makeRelayToolsExtension(user.id)];
    } else {
      // Host mode keeps the caller-supplied server directory.
      if (!effectiveCwd || !existsSync(effectiveCwd)) {
        return NextResponse.json({ error: `Directory does not exist: ${String(effectiveCwd)}` }, { status: 400 });
      }
    }

    if (!effectiveCwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    // User sessions live in the caller's shard; host sessions in the global dir.
    if (user.id !== 0 && mode !== "host") {
      sessionDir = spaceDir({ kind: "user", userId: user.id });
    }
    if (mode === "host" && user.id !== 0) {
      // Admin host sessions also go to the admin's shard (CLI keeps the root).
      sessionDir = spaceDir({ kind: "user", userId: user.id });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", effectiveCwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(sessionDir ? { sessionDir } : {}),
      ownerId: user.id,
      mode,
      ...(additionalExtensionPaths ? { additionalExtensionPaths } : {}),
      ...(extensionFactories ? { extensionFactories } : {}),
    });

    recordSessionMeta(realSessionId, { mode, ownerId: user.id, ownerName: user.username });
    invalidateSessionListCache();

    // Host-mode sessions keep the files-route allowed-roots cache in sync so
    // the cwd is immediately readable via /api/files (sandbox/local sessions
    // don't expose server-local files at all).
    if (mode === "host") {
      allowFileRoot(effectiveCwd);
    }

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        mode,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      mode,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
