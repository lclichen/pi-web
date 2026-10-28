/**
 * Sandbox-platform tools extension (merged from the standalone
 * pi-sandbox-extension package — CLI 与 WebUI 复用同一份；该包已废弃).
 *
 * Connects the pi coding agent to a centralized Apptainer sandbox management
 * platform and routes the built-in tools (read, write, edit, bash, grep,
 * find, ls) into the selected container via the platform's REST relay. The
 * platform is the middleman: every tool operation is forwarded to
 * /api/v1/containers/:id/tools/* which executes it inside the Apptainer
 * instance and returns the result.
 *
 * Activation (see config-bridge.sandboxConfigPresent):
 *   · CLI: amedac-core registers this module when the launch directory (or
 *     SANDBOX_* env) carries sandbox config — /sandbox-login etc. remain
 *     available from there.
 *   · pi-web: the session factory is injected inline per sandbox session
 *     (agent/new + session-restore-options + subagent-bridge), so non-sandbox
 *     sessions in the same process never load it.
 * session_start additionally no-ops unless <ctx.cwd>/.pi/sandbox-platform.json
 * (or env) is present — the tools then pass through to the built-ins.
 */
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type GrepToolInput,
  truncateHead,
  type BeforeProviderRequestEvent,
} from "@earendil-works/pi-coding-agent";
import { makeClient, ensureAuthenticated, ensureContainer, getState, setState } from "./auth.ts";
import { ensureLlmProvider, providerNameForSessionTracking } from "./llm.ts";
import { createContainerAutocompleteProvider } from "./autocomplete.ts";
import { containerPathToLocal } from "./paths.ts";
import { matchRuntimeConfigFile, sandboxConfigPresent } from "./config-bridge.ts";

export { matchRuntimeConfigFile, sandboxConfigPresent };
import {
  createPlatformBashOps,
  createPlatformEditOps,
  createPlatformLsOps,
  createPlatformReadOps,
  createPlatformWriteOps,
  withContainerCwd,
  GUEST_WORKSPACE,
  platformFind,
  platformGrep,
} from "./operations.ts";
import { registerCommands } from "./commands.ts";

export function makeSandboxToolsExtension(): InlineExtension {
  const factory = (pi: ExtensionAPI): void => {
    // A CLI flag to pin a container id on startup.
    pi.registerFlag("sandbox-container", {
      description: "Container id to connect to on startup",
      type: "string",
    });

    registerCommands(pi);

    // Hold local tool instances so we can fall back to host execution when no
    // container is connected (lets the extension load harmlessly offline).
    // The real session cwd arrives at session_start (ctx.cwd); until then use
    // the process cwd (pi is usually launched from the project dir).
    let sessionCwd = process.cwd();
    const localCwd = sessionCwd;
    const localRead = createReadTool(localCwd);
    const localWrite = createWriteTool(localCwd);
    const localEdit = createEditTool(localCwd);
    const localBash = createBashTool(localCwd);
    const localLs = createLsTool(localCwd);
    const localFind = createFindTool(localCwd);
    const localGrep = createGrepTool(localCwd);

    // Runtime-config bridge (config-bridge.ts): skills and subagent
    // definitions live on the HOST, never in the container — config-shaped
    // read/ls stays host-side whatever prefix the model used.
    const bridgedConfigPath = (requested: string): string | null => matchRuntimeConfigFile(requested, [sessionCwd]);

    // add session_id key for tracking. Applies to whichever LLM provider this
    // extension registered (default "amedac.ai"), plus the bare "litellm" name
    // for setups that register under that name.
    pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
      const payload = event.payload as Record<string, unknown>;
      if (!payload) return;

      const provider = ctx.model?.provider;
      if (!provider || !providerNameForSessionTracking().has(provider)) return payload;

      const sessionId = ctx.sessionManager?.getSessionId();
      if (!sessionId) {
        console.warn("missing session id");
        return payload;
      }

      return {
        ...payload,
        litellm_session_id: sessionId,
      };
    });

    // Resolve the client/container on session_start so the first user prompt
    // can use the routed tools. Sessions without sandbox config (module
    // loaded but cwd not configured) skip entirely — tools pass through.
    pi.on("session_start", async (event, ctx) => {
      sessionCwd = ctx.cwd;
      if (!sandboxConfigPresent(sessionCwd)) return;
      const { client, config } = makeClient(ctx.cwd);
      setState({ client, config, containerId: undefined, instanceName: undefined }, sessionCwd);
      // `@` file completion reads container files when a container is connected
      // (wraps the built-in local-fd provider; delegates when not connected).
      ctx.ui.addAutocompleteProvider((current) =>
        createContainerAutocompleteProvider(current, () => {
          const st = getState(sessionCwd);
          return st && st.containerId !== undefined ? { client: st.client, containerId: st.containerId } : undefined;
        }),
      );
      if (!(await ensureAuthenticated(client, ctx))) return;
      // Auto-provision the LLM provider (LiteLLM virtual key) in the background.
      // Failures here must NOT block the container/tools flow — LLM is optional.
      void ensureLlmProvider(pi, ctx, client).catch((err) => {
        console.warn(`[sandbox-platform] LLM provider setup failed: ${err}`);
      });
      const id = await ensureContainer(pi, ctx, client);
      if (id) ctx.ui.notify(`Sandbox connected: container ${id}.`, "info");
    });

    pi.on("session_shutdown", async () => {
      setState(undefined, sessionCwd);
    });

    // Helper: resolve the active container id, or null to fall back to host.
    async function activeContainerId(ctx: ExtensionContext): Promise<number | null> {
      const st = getState(sessionCwd);
      if (!st) return null;
      if (st.containerId) return st.containerId;
      if (!(await ensureAuthenticated(st.client, ctx))) return null;
      const id = await ensureContainer(pi, ctx, st.client);
      return id ?? null;
    }

    /**
     * Local-fallback policy. Embedded hosts (pi-web) set disableLocalFallback in
     * the project's sandbox-platform.json: a sandbox session whose container is
     * unreachable MUST fail loudly — silently running tool commands on the HOST
     * (the pi-web server!) is a correctness and security hole. Plain CLI usage
     * keeps the traditional local fallback (the cwd IS the workspace there).
     */
    function localFallbackBlocked(): boolean {
      return Boolean(getState(sessionCwd)?.config.disableLocalFallback);
    }

    function fallbackDenied(): never {
      // pi 0.84: tool errors are signalled by throwing; a returned `isError`
      // flag is ignored and the result would be treated as success.
      throw new Error(
        "沙箱不可用：未连接容器，且本部署已禁用本地回退（disableLocalFallback）。请检查容器状态（项目设置/沙箱管理面板）后重试。",
      );
    }

    // ---- override built-in tools, routing into the container ----

    pi.registerTool({
      ...localRead,
      async execute(id, params, signal, onUpdate, ctx) {
        // Skills/agents live on the host, outside the container — bridge
        // config-shaped reads before container routing.
        const bridged = bridgedConfigPath(params.path);
        if (bridged) return localRead.execute(id, { ...params, path: bridged }, signal, onUpdate);
        const cid = await activeContainerId(ctx);
        if (!cid) {
          // Offline fallback: container-style paths map to the local project.
          if (localFallbackBlocked()) return fallbackDenied();
          return localRead.execute(
            id,
            { ...params, path: containerPathToLocal(params.path, sessionCwd) },
            signal,
            onUpdate,
          );
        }
        const tool = createReadTool(GUEST_WORKSPACE, {
          operations: createPlatformReadOps(getState(sessionCwd)!.client, cid, sessionCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localWrite,
      async execute(id, params, signal, onUpdate, ctx) {
        const cid = await activeContainerId(ctx);
        if (!cid) {
          if (localFallbackBlocked()) return fallbackDenied();
          return localWrite.execute(
            id,
            { ...params, path: containerPathToLocal(params.path, sessionCwd) },
            signal,
            onUpdate,
          );
        }
        const tool = createWriteTool(GUEST_WORKSPACE, {
          operations: createPlatformWriteOps(getState(sessionCwd)!.client, cid, sessionCwd),
        });
        const result = await tool.execute(id, params, signal, onUpdate);
        if (isInstructionsPath(params.path)) {
          await mirrorInstructionsContent(params.content, sessionCwd);
        }
        return result;
      },
    });

    pi.registerTool({
      ...localEdit,
      async execute(id, params, signal, onUpdate, ctx) {
        const cid = await activeContainerId(ctx);
        if (!cid) {
          if (localFallbackBlocked()) return fallbackDenied();
          return localEdit.execute(
            id,
            { ...params, path: containerPathToLocal(params.path, sessionCwd) },
            signal,
            onUpdate,
          );
        }
        const tool = createEditTool(GUEST_WORKSPACE, {
          operations: createPlatformEditOps(getState(sessionCwd)!.client, cid, sessionCwd),
        });
        const result = await tool.execute(id, params, signal, onUpdate);
        if (isInstructionsPath(params.path)) {
          // Mirror the edited file back verbatim via the raw platform read ops
          // (tool-level reads carry line numbers; ops do not).
          try {
            const raw = await createPlatformReadOps(getState(sessionCwd)!.client, cid, sessionCwd).readFile(
              params.path,
            );
            await mirrorInstructionsContent(raw.toString("utf8"), sessionCwd);
          } catch {
            // best-effort mirror
          }
        }
        return result;
      },
    });

    /** Workspace-root instruction files that must stay mirrored to the local
     *  project directory (see mirrorInstructionsContent). */
    function isInstructionsPath(guestPath: string): boolean {
      const normalized = guestPath.replace(/^\/+/, "");
      return normalized === "AGENTS.md" || normalized === `${GUEST_WORKSPACE.replace(/^\/+/, "")}/AGENTS.md`;
    }

    /**
     * AGENTS.md lives in the local project directory (the platform directory in
     * embedded hosts) — that is where pi loads session instructions from and
     * where project duplication picks it up. The workspace sync is one-way
     * (home -> container /workspace), so agent writes to the workspace-root
     * copy are mirrored back here. Best-effort by design.
     */
    async function mirrorInstructionsContent(content: string, cwd: string): Promise<void> {
      try {
        await writeFile(join(cwd, "AGENTS.md"), content, "utf8");
      } catch {
        // best-effort mirror
      }
    }

    pi.registerTool({
      ...localBash,
      async execute(id, params, signal, onUpdate, ctx) {
        const cid = await activeContainerId(ctx);
        if (!cid) {
          if (localFallbackBlocked()) return fallbackDenied();
          return localBash.execute(id, params, signal, onUpdate);
        }
        const tool = createBashTool(GUEST_WORKSPACE, {
          operations: createPlatformBashOps(getState(sessionCwd)!.client, cid),
        });
        return tool.execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localLs,
      async execute(id, params, signal, onUpdate, ctx) {
        // Same config bridge as read: list the host-side skills/agents trees.
        const bridged = bridgedConfigPath(params.path ?? "");
        if (bridged) return localLs.execute(id, { ...params, path: bridged }, signal, onUpdate);
        const cid = await activeContainerId(ctx);
        if (!cid) {
          if (localFallbackBlocked()) return fallbackDenied();
          return localLs.execute(
            id,
            { ...params, path: containerPathToLocal(params.path ?? ".", sessionCwd) },
            signal,
            onUpdate,
          );
        }
        const tool = createLsTool(GUEST_WORKSPACE, {
          operations: createPlatformLsOps(getState(sessionCwd)!.client, cid, sessionCwd),
        });
        return tool.execute(id, params, signal, onUpdate);
      },
    });

    pi.registerTool({
      ...localFind,
      async execute(id, params, signal, onUpdate, ctx) {
        const cid = await activeContainerId(ctx);
        if (!cid) {
          if (localFallbackBlocked()) return fallbackDenied();
          return localFind.execute(
            id,
            { ...params, path: containerPathToLocal(params.path ?? ".", sessionCwd) },
            signal,
            onUpdate,
          );
        }
        const st = getState(sessionCwd)!;
        const results = await platformFind(
          st.client,
          cid,
          {
            pattern: params.pattern,
            path: params.path,
            limit: params.limit,
          },
          sessionCwd,
        );
        const { content } = truncateHead(results.join("\n"));
        return {
          content: [{ type: "text", text: content || "No matches" }],
          details: {},
        };
      },
    });

    pi.registerTool({
      ...localGrep,
      async execute(_id, params: GrepToolInput, _signal, _onUpdate, ctx) {
        const cid = await activeContainerId(ctx);
        if (!cid) {
          if (localFallbackBlocked()) return fallbackDenied();
          return localGrep.execute(
            _id,
            { ...params, path: containerPathToLocal(params.path ?? ".", sessionCwd) },
            _signal,
            _onUpdate,
          );
        }
        const st = getState(sessionCwd)!;
        const output = await platformGrep(
          st.client,
          cid,
          {
            pattern: params.pattern,
            path: params.path,
            glob: params.glob,
            literal: params.literal,
            ignoreCase: params.ignoreCase,
            context: params.context,
            limit: params.limit,
          },
          sessionCwd,
        );
        const { content } = truncateHead(output);
        return {
          content: [{ type: "text", text: content || "No matches found" }],
          details: {},
        };
      },
    });

    // Route user `!`/`!!` shell commands into the container too. pi passes the
    // LOCAL session cwd to these operations; pin it to the container workspace
    // root instead (withContainerCwd), where the synced project lives.
    pi.on("user_bash", async (_event, _ctx) => {
      const st = getState(sessionCwd);
      if (!st?.containerId) return; // fall back to local
      return { operations: withContainerCwd(createPlatformBashOps(st.client, st.containerId)) };
    });

    // Rewrite the system prompt's cwd to the guest workspace when connected.
    pi.on("before_agent_start", async (event, _ctx) => {
      const st = getState(sessionCwd);
      if (!st?.containerId) return;
      const localLine = `Current working directory: ${sessionCwd}`;
      const guestLine = `Current working directory: ${GUEST_WORKSPACE} (sandbox platform container ${st.containerId}; platform ${st.client.url})`;
      const systemPrompt = event.systemPrompt.includes(localLine)
        ? event.systemPrompt.replace(localLine, guestLine)
        : `${event.systemPrompt}\n\n${guestLine}`;
      return { systemPrompt };
    });

    // Keep a persistent visible indicator that tool calls run in the remote
    // container, refreshed every turn so it never disappears during a session.
    pi.on("turn_start", async (_event, ctx) => {
      const st = getState(sessionCwd);
      if (!st?.containerId) return;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🔒 sandbox:${GUEST_WORKSPACE} (container ${st.containerId} · remote)`),
      );
    });
  };

  return { name: "amedac-sandbox-tools", factory, hidden: true };
}
