/**
 * Batch task runner — orchestrates a single test task's lifecycle.
 *
 * Responsibilities:
 * 1. Prepare the working directory (auto-create + trust + suffix-if-exists)
 * 2. Materialize test files (inline JSON map + optional zip/path package)
 * 3. Start a pi agent session in the requested mode (host | sandbox)
 * 4. Send the prompt and monitor until terminal state
 * 5. Auto-respond to blocking UI requests after inputTimeoutMs
 *    (ask_user_question → "proceed with recommended"; exit_plan_mode → approve)
 * 6. Collect results (final text, tool call log, usage, artifacts)
 * 7. Cleanup (stop sandbox container if requested)
 *
 * The auto-responder is the key ACP lesson applied: "requires_action" is a
 * first-class state; after timeout we provide a deterministic answer rather
 * than cancelling the task or guessing permissions.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { startRpcSession, type AgentSessionWrapper } from "../rpc-manager.ts";
import { trustProject } from "../project-trust.ts";
import { toClientAgentEvent } from "../agent-event-wire.ts";
import { writeSandboxConfig } from "../projects.ts";
import { dataDir } from "../mode-homes.ts";
import { resolveCoreExtensionPaths } from "../session-restore-options.ts";
import { makeRemoteVerifyExtension } from "../extensions/remote-verify.ts";
import { makeEnvironmentInfoExtension } from "../extensions/environment-info.ts";
import { makeBgTasksExtension } from "../extensions/bg-tasks.ts";
import { registerBgChannel } from "../extensions/bg-shell.ts";
import { makeSandboxBgChannel } from "../extensions/bg-channels.ts";
import { getTask, publishTaskEvent, updateTask, type BatchTask, type BatchStopReason } from "./task-store.ts";

// ---------------------------------------------------------------------------
// Directory preparation
// ---------------------------------------------------------------------------

/**
 * Per-task stub home for sandbox-mode batch tasks (mirrors the per-user
 * sandbox homes): its .pi/sandbox-platform.json carries the platform url,
 * API key and the task's containerId for the sandbox bridge extension.
 * Per-task (not per-user) so concurrent batch tasks never fight over one
 * config file.
 */
export function ensureBatchHome(taskId: string): string {
  const home = join(dataDir(), "batch-homes", taskId);
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Resolve the actual working directory: if the requested path already exists,
 * append -2, -3, ... until a fresh directory is available. Always creates +
 * trusts the directory.
 */
export function prepareWorkDir(requested: string): string {
  let dir = resolve(requested);
  if (existsSync(dir)) {
    let suffix = 2;
    while (existsSync(`${requested}-${suffix}`)) suffix++;
    dir = resolve(`${requested}-${suffix}`);
  }
  mkdirSync(dir, { recursive: true });
  trustProject(dir, getAgentDir());
  return dir;
}

// ---------------------------------------------------------------------------
// File materialization
// ---------------------------------------------------------------------------

export function materializeFiles(
  workDir: string,
  files: Record<string, string>,
): void {
  for (const [relPath, content] of Object.entries(files)) {
    // Path traversal guard
    const safe = resolve(workDir, relPath);
    if (!safe.startsWith(resolve(workDir))) {
      throw new Error(`File path escapes workDir: ${relPath}`);
    }
    const parent = join(safe, "..");
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(safe, content, "utf8");
  }
}

export function copyPathPackage(workDir: string, sourcePath: string): void {
  const src = resolve(sourcePath);
  if (!existsSync(src)) throw new Error(`File package path not found: ${sourcePath}`);
  const stat = statSync(src);
  if (stat.isFile()) {
    // Single file: copy to workDir root
    copyFileSync(src, join(workDir, src.split("/").pop() ?? "package-file"));
    return;
  }
  if (!stat.isDirectory()) throw new Error(`File package path is neither file nor directory: ${sourcePath}`);
  // Directory: recursive copy
  copyDirRecursive(src, workDir);
}

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-responder for blocking UI requests
// ---------------------------------------------------------------------------

interface UiResponder {
  stop: () => void;
}

/**
 * Watch for extension_ui_request events on the session and auto-respond to
 * blocking dialogs (select/confirm/input) after the input timeout:
 * - select → pick the first option (the recommended one by convention)
 * - confirm → true (auto-approve)
 * - input → empty string (model decides what to do)
 *
 * Dialog arrival flips the task into `waiting_input`; the auto-answer (or a
 * human response over the session) flips it back to `running`. The responder
 * is non-destructive: if a human answers first (via SSE), the
 * pendingUiResponses entry resolves and our late response is a no-op.
 */
function attachAutoResponder(
  wrapper: AgentSessionWrapper,
  inputTimeoutMs: number,
  taskId: string,
): UiResponder {
  let active = true;
  const timers: Set<ReturnType<typeof setTimeout>> = new Set();

  const unsubscribe = wrapper.onEvent((event: { type?: string; method?: string; id?: string; title?: string; options?: string[] }) => {
    if (!active || event.type !== "extension_ui_request") return;
    if (!event.id || !event.method) return;
    const method = event.method;
    if (method !== "select" && method !== "confirm" && method !== "input") return;

    // Surface the wait in the task state (and thus the SSE stream).
    if (getTask(taskId)?.state === "running") {
      updateTask(taskId, { state: "waiting_input" });
    }

    const requestEvent = event as { id: string; method: string; title?: string; options?: string[] };
    const timer = setTimeout(() => {
      timers.delete(timer);
      let response: Record<string, unknown>;
      switch (method) {
        case "select":
          // Pick the first option = recommended by convention
          response = { type: "extension_ui_response", id: requestEvent.id, value: requestEvent.options?.[0] };
          break;
        case "confirm":
          response = { type: "extension_ui_response", id: requestEvent.id, confirmed: true };
          break;
        case "input":
          response = { type: "extension_ui_response", id: requestEvent.id, value: "" };
          break;
        default:
          return;
      }
      try {
        // Fire-and-forget: the wrapper's pendingUiResponses either accepts it
        // (timeout won) or ignores it (human answered first).
        void wrapper.send(response);
      } catch {
        // Session may have ended — best-effort
      }
      if (getTask(taskId)?.state === "waiting_input") {
        updateTask(taskId, { state: "running" });
      }
    }, inputTimeoutMs);
    timers.add(timer);
  });

  return {
    stop: () => {
      active = false;
      unsubscribe?.();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Main task execution
// ---------------------------------------------------------------------------

export interface RunTaskOptions {
  taskId: string;
  prompt: string;
  /** Host mode: server directory to prepare. Sandbox mode: unused (home is derived). */
  workDir: string;
  files?: Record<string, string>;
  filePackagePath?: string;
  mode: "host" | "sandbox";
  model?: { provider: string; modelId: string };
  timeoutMs: number;
  inputTimeoutMs: number;
  /** Ignored in sandbox mode — the caller owns the container lifecycle. */
  stopContainer: boolean;
  ownerId: number;
  /** Sandbox mode: platform container the seven coding tools route into. */
  containerId?: number;
  projectId?: number;
  /** Sandbox mode: platform API key used by the bridge extension. */
  platformApiKey?: string;
  /** environment-info username (product parity in the system prompt). */
  username?: string;
  /** Active tool allowlist (eval fidelity: disable host-side web tools etc.). */
  toolNames?: string[];
  /** Resume after a pi-web restart: reopen the persisted session file and skip
   * dir preparation / file materialization (state already on disk). */
  resume?: boolean;
}

export async function runBatchTask(options: RunTaskOptions): Promise<void> {
  const { taskId } = options;
  let wrapper: AgentSessionWrapper | undefined;
  let responder: UiResponder | undefined;
  let unsubscribeAgentEvents: (() => void) | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    updateTask(taskId, { state: "running", startedAt: Date.now() });

    // 1. Resolve the session cwd and per-mode wiring.
    //    - host: prepare a fresh workDir (suffix-if-exists) + materialize files
    //    - sandbox: per-task stub home whose .pi/sandbox-platform.json binds
    //      the bridge extension to the caller's container; the repo lives in
    //      the container image, files/filePackagePath are rejected at the route
    let sessionCwd: string;
    if (options.mode === "sandbox") {
      const extPath = process.env.PI_WEB_SANDBOX_EXTENSION_PATH;
      if (!process.env.PI_WEB_PLATFORM_URL) throw new Error("沙盒模式未配置（缺少 PI_WEB_PLATFORM_URL）");
      if (!extPath || !existsSync(extPath)) throw new Error("沙盒模式未配置（PI_WEB_SANDBOX_EXTENSION_PATH 无效）");
      if (options.containerId === undefined) throw new Error("sandbox mode requires containerId");
      if (!options.platformApiKey) throw new Error("sandbox mode requires platformApiKey");
      sessionCwd = ensureBatchHome(taskId);
      writeSandboxConfig(sessionCwd, { apiKey: options.platformApiKey, containerId: options.containerId });
      updateTask(taskId, { homeDir: sessionCwd });
    } else if (options.resume) {
      // Resume (host): reuse the previously prepared directory as-is.
      const task = getTask(taskId);
      sessionCwd = task?.actualWorkDir || prepareWorkDir(options.workDir);
    } else {
      sessionCwd = prepareWorkDir(options.workDir);
    }
    updateTask(taskId, { actualWorkDir: sessionCwd });

    // 2. Materialize files (host mode, fresh runs only)
    if (!options.resume && options.mode !== "sandbox") {
      if (options.files) materializeFiles(sessionCwd, options.files);
      if (options.filePackagePath) copyPathPackage(sessionCwd, options.filePackagePath);
    }

    // 3. Start agent session (resume: reopen the persisted session file)
    const sessionId = `batch-${taskId.slice(0, 8)}-${Date.now().toString(36)}`;
    const resumeFile = options.resume ? getTask(taskId)?.sessionFile : undefined;
    const coreOptions = {
      ownerId: options.ownerId,
      mode: options.mode,
      ...(options.model ? { initialModel: options.model } : {}),
      ...(options.toolNames ? { toolNames: options.toolNames } : {}),
    };
    const { session } = await startRpcSession(
      sessionId,
      resumeFile ?? "",
      resumeFile ? undefined : sessionCwd,
      options.mode === "sandbox"
        ? {
            ...coreOptions,
            additionalExtensionPaths: resolveCoreExtensionPaths([process.env.PI_WEB_SANDBOX_EXTENSION_PATH!]),
            extensionFactories: [
              makeBgTasksExtension(),
              makeRemoteVerifyExtension("sandbox", options.ownerId),
              makeEnvironmentInfoExtension({
                mode: "sandbox",
                username: options.username ?? "batch",
                containerId: options.containerId,
              }),
            ],
          }
        : {
            ...coreOptions,
            extensionFactories: [
              makeBgTasksExtension(),
              makeEnvironmentInfoExtension({ mode: "host", username: options.username ?? "batch" }),
            ],
          },
    );
    wrapper = session;
    const realSessionId = wrapper.sessionId;
    // Record the session file immediately (not just at completion) so an
    // interruption at any point leaves a resumable record on disk.
    updateTask(taskId, { sessionId: realSessionId, ...(wrapper.sessionFile ? { sessionFile: wrapper.sessionFile } : {}) });

    // Pin the model through the product set_model path. Startup selection
    // drops providers the runtime does not count as "configured" (custom
    // models.json providers with inline keys fail hasConfiguredAuth), leaving
    // a model-less session whose prompt resolves instantly with zero output —
    // found live on the VM with Modelscope-Free.
    if (options.model) {
      await wrapper.send({ type: "set_model", provider: options.model.provider, modelId: options.model.modelId });
    }

    if (options.mode === "sandbox") {
      // bg-shell channel: sandbox tasks run INSIDE the container via the
      // platform tools/bash API — never a server-side local spawn.
      registerBgChannel(realSessionId, makeSandboxBgChannel(options.platformApiKey!, options.containerId!));
    }

    // 4. Attach auto-responder for interactive tools
    responder = attachAutoResponder(wrapper, options.inputTimeoutMs, taskId);

    // 4b. Forward agent events into the task channel (SSE stream consumers).
    // Same wire projection as the WebUI's own event stream, so batch clients
    // see message deltas, tool calls and tool updates as they happen.
    unsubscribeAgentEvents = wrapper.onEvent((event) => {
      const clientEvent = toClientAgentEvent(event as { type: string; [key: string]: unknown });
      if (clientEvent) {
        publishTaskEvent(taskId, {
          type: "agent_event",
          agentEvent: clientEvent as Record<string, unknown>,
        });
      }
    });

    // 5. Overall timeout: abort the in-flight prompt through the session
    // (same mechanism as the cancel route). A bare AbortController here was
    // never wired to anything — long tasks would hang past their deadline.
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void wrapper!.send({ type: "abort" }).catch(() => {
        // Session may already be gone — the send below settles either way
      });
    }, options.timeoutMs);

    // 6. Send the prompt and wait for the agent to SETTLE. Field is `message`
    // (the WebUI wire shape; a `content` field dies inside the SDK's message
    // parsing). send(prompt) resolves at ADMISSION (preflight), not at run
    // completion — the WebUI tracks agent_settled events instead — so poll
    // get_state until the run finishes (found live: collecting results right
    // after send() saw an empty transcript and disposed a mid-flight run).
    await wrapper.send({ type: "prompt", message: options.prompt });
    const settleDeadline = Date.now() + options.timeoutMs + 300_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = (await wrapper.send({ type: "get_state" }).catch(() => null)) as {
        isPromptRunning?: boolean; isStreaming?: boolean; isCompacting?: boolean; isBashRunning?: boolean;
      } | null;
      if (!st) break; // session gone — treat as settled, result collection below runs best-effort
      const busy = st.isPromptRunning || st.isStreaming || st.isCompacting || st.isBashRunning;
      if (!busy) break;
      if (Date.now() > settleDeadline) {
        // The abort timer should have fired long before this; last resort.
        await wrapper.send({ type: "abort" }).catch(() => {});
        break;
      }
    }

    // 7. Collect results — use the wrapper's inner session for stats/messages
    clearTimeout(timeoutTimer);
    responder.stop();

    const inner = (wrapper as unknown as { inner: { getSessionStats(): { tokens: { input: number; output: number; total: number }; toolCalls: number }; messages: MinimalMessage[]; sessionManager: { getBranch(): Array<{ type?: string; message?: MinimalMessage }>; sessionFile?: string }; sessionFile?: string; dispose(): void } }).inner;
    const stats = inner.getSessionStats();
    // inner.messages is the agent transcript (role/content/stopReason); the
    // session file's raw entries nest it under {type:"message",message} —
    // reading the entry tree directly yields no roles (v1.2 bug, only visible
    // once a real model run was wired through).
    const messages: MinimalMessage[] = Array.isArray(inner.messages)
      ? inner.messages
      : inner.sessionManager.getBranch().map((e) => e.message).filter((m): m is MinimalMessage => Boolean(m));
    const lastAssistant = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant");
    const finalText =
      (lastAssistant as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
        ?.filter((p) => p.type === "text" && p.text)
        ?.map((p) => p.text ?? "")
        ?.join("\n") ?? "";
    const stopReason = ((lastAssistant as { stopReason?: string } | undefined)?.stopReason) ?? "end_turn";

    const toolCallLog = collectToolCalls(messages);
    const artifacts = options.mode === "sandbox"
      // Sandbox artifacts live inside the container; the caller collects them
      // (e.g. deep-swe verifier.collect via the platform tools API).
      ? []
      : scanArtifacts(sessionCwd);
    const sessionFile = wrapper.sessionFile;

    updateTask(taskId, {
      state: timedOut ? "cancelled" : "completed",
      stopReason: timedOut ? "timeout" : normalizeStopReason(stopReason),
      endedAt: Date.now(),
      finalResponse: finalText,
      summary: finalText.slice(0, 200),
      usage: {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
        toolCalls: stats.toolCalls,
      },
      toolCallLog,
      artifacts,
      sessionFile,
    });
  } catch (e) {
    if (responder) responder.stop();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    console.error(`[batch] task ${taskId} failed:`, e);
    updateTask(taskId, {
      state: timedOut ? "cancelled" : "failed",
      stopReason: timedOut ? "timeout" : "error",
      endedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    unsubscribeAgentEvents?.();
    // Sandbox containers belong to the caller (the eval runner provisions and
    // disposes them) — no platform stop is issued here.
    // Dispose the session wrapper's inner session
    try {
      (wrapper as unknown as { inner: { dispose(): void } }).inner?.dispose();
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MinimalMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
  toolName?: string;
  isError?: boolean;
}

function collectToolCalls(messages: unknown[]): BatchTask["toolCallLog"] {
  const log: NonNullable<BatchTask["toolCallLog"]> = [];
  for (const msg of messages as MinimalMessage[]) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "toolCall" && part.name) {
          log.push({
            name: part.name,
            argumentsSummary: JSON.stringify(part.arguments ?? {}).slice(0, 200),
            resultSummary: "",
            isError: false,
            durationMs: 0,
          });
        }
      }
    } else if (msg.role === "toolResult" && msg.toolName && log.length > 0) {
      // Attach result to the most recent matching call
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].name === msg.toolName && !log[i].resultSummary) {
          const text = Array.isArray(msg.content)
            ? msg.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")
            : "";
          log[i].resultSummary = text.slice(0, 200);
          log[i].isError = msg.isError === true;
          break;
        }
      }
    }
  }
  return log;
}

function scanArtifacts(workDir: string): BatchTask["artifacts"] {
  const results: NonNullable<BatchTask["artifacts"]> = [];
  try {
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const rel = full.slice(workDir.length + 1).replace(/\\/g, "/");
          results.push({ path: rel, size: statSync(full).size });
        }
      }
    };
    walk(workDir, 0);
  } catch {
    // best-effort
  }
  return results.slice(0, 100); // cap at 100 entries
}

function normalizeStopReason(raw: string): BatchStopReason {
  switch (raw) {
    case "end_turn":
    case "stop":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}
