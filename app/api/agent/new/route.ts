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
import { makeRemoteVerifyExtension } from "@/lib/extensions/remote-verify";
import { ensureProjectHome, getOwnedProject, writeSandboxConfig, type ProjectRecord } from "@/lib/projects";
import { getAgentForUser } from "@/lib/relay/registry";
import { isApiRequestAllowed } from "@/lib/request-security";
import { platformGet } from "@/lib/platform/client";
import { readSandboxHomeConfig, setSandboxContainer } from "@/lib/mode-homes";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}

/**
 * Resolve which container an unbound sandbox session should target. The
 * sandbox extension's CLI fallback is INTERACTIVE (it prompts when several
 * containers are running) — unusable in an embedded RPC session. pi-web
 * resolves deterministically instead: exactly one running container is
 * auto-picked; several require an explicit binding (clear 409); none leaves
 * it unset so the extension's out-of-box auto-provision still applies.
 */
async function resolveAutoContainer(
  apiKey: string,
): Promise<{ containerId?: number; conflict?: string }> {
  const list = await platformGet<{ containers: Array<{ id: number; name: string }> }>(
    "/api/v1/containers",
    apiKey,
    { filter: "running" },
  );
  const running = list.containers ?? [];
  if (running.length === 1) return { containerId: running[0].id };
  if (running.length > 1) {
    return {
      conflict: `有 ${running.length} 个容器在运行（${running.map((c) => `#${c.id} ${c.name}`).join("、")}），请在项目菜单里绑定其中一个，或停止多余的容器`,
    };
  }
  return {};
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
    const effectiveMode = typeof body.projectId === "string" && body.projectId
      ? (getOwnedProject(body.projectId, user.id, user.role === "admin")?.mode ?? mode)
      : mode;
    const permission = modeAllowedForUser(effectiveMode, { id: user.id, role: user.role });
    if (!permission.ok) {
      return NextResponse.json({ error: permission.reason }, { status: 403 });
    }

    let effectiveCwd: string | undefined = typeof cwd === "string" ? cwd : undefined;
    let additionalExtensionPaths: string[] | undefined;
    let extensionFactories: InlineExtension[] | undefined;
    let sessionDir: string | undefined;

    // Project-scoped session (sandbox / local-machine): the project record —
    // not the client — decides mode and home directory.
    let projectRef: ProjectRecord | undefined;
    if (typeof body.projectId === "string" && body.projectId) {
      if (user.id === 0) {
        return NextResponse.json({ error: "项目会话需要登录（多用户模式）" }, { status: 400 });
      }
      const project = getOwnedProject(body.projectId, user.id, user.role === "admin");
      if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
      projectRef = project;
      const home = ensureProjectHome(project);
      if (project.mode === "sandbox") {
        if (!process.env.PI_WEB_PLATFORM_URL) {
          return NextResponse.json({ error: "沙箱模式未配置（缺少 PI_WEB_PLATFORM_URL）" }, { status: 400 });
        }
        if (!identity.session.apiKey) {
          return NextResponse.json({ error: "沙箱模式需要平台凭证，请重新登录" }, { status: 401 });
        }
        const extPath = process.env.PI_WEB_SANDBOX_EXTENSION_PATH;
        if (!extPath || !existsSync(extPath)) {
          return NextResponse.json({ error: "沙箱模式未配置（PI_WEB_SANDBOX_EXTENSION_PATH 无效）" }, { status: 400 });
        }
        // Project's own .pi/sandbox-platform.json carries url/container; refresh credentials.
        writeSandboxConfig(home, { apiKey: identity.session.apiKey });
        if (project.containerId) {
          writeSandboxConfig(home, { containerId: project.containerId });
        } else {
          // Unbound project ("跟随平台默认"): resolve deterministically here —
          // the extension's interactive container picker cannot run in RPC mode.
          let containerId = Number(readSandboxHomeConfig(user.id).containerId) || 0;
          if (!containerId) {
            const auto = await resolveAutoContainer(identity.session.apiKey);
            if (auto.conflict) {
              return NextResponse.json({ error: auto.conflict }, { status: 409 });
            }
            containerId = auto.containerId ?? 0;
          }
          if (containerId) writeSandboxConfig(home, { containerId });
        }
        additionalExtensionPaths = [extPath];
        extensionFactories = [makeRemoteVerifyExtension("sandbox", user.id)];
      } else {
        if (!getAgentForUser(user.id)?.info) {
          return NextResponse.json({ error: "本机模式需要先配对你的电脑（本机面板 → 连接本机）" }, { status: 400 });
        }
        extensionFactories = [makeRelayToolsExtension(user.id), makeRemoteVerifyExtension("local-machine", user.id)];
      }
      effectiveCwd = home;
    } else if (mode === "sandbox") {
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
      if (user.id !== 0 && !Number(readSandboxHomeConfig(user.id).containerId)) {
        // No user-pinned default: resolve deterministically (same reasoning
        // as the project branch — no interactive picker in RPC mode).
        const auto = await resolveAutoContainer(identity.session.apiKey);
        if (auto.conflict) {
          return NextResponse.json({ error: auto.conflict }, { status: 409 });
        }
        if (auto.containerId) setSandboxContainer(user.id, auto.containerId);
      }
      additionalExtensionPaths = [extPath];
      extensionFactories = [makeRemoteVerifyExtension("sandbox", user.id)];
    } else if (mode === "local-machine") {
      if (user.id !== 0 && !getAgentForUser(user.id)?.info) {
        return NextResponse.json({ error: "本机模式需要先配对你的电脑（本机面板 → 连接本机）" }, { status: 400 });
      }
      effectiveCwd = ensureLocalHome(user.id);
      extensionFactories = [makeRelayToolsExtension(user.id), makeRemoteVerifyExtension("local-machine", user.id)];
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
      ...(projectRef ? { projectCredentialDir: effectiveCwd } : {}),
    });

    recordSessionMeta(realSessionId, { mode: effectiveMode, ownerId: user.id, ownerName: user.username, ...(projectRef ? { projectId: projectRef.id } : {}) });
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
        mode: effectiveMode,
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
