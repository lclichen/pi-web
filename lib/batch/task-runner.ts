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
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "../rpc-manager.ts";
import { trustProject } from "../project-trust.ts";
import { updateTask, type BatchTask, type BatchStopReason } from "./task-store.ts";

// ---------------------------------------------------------------------------
// Directory preparation
// ---------------------------------------------------------------------------

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
    const { copyFileSync } = require("node:fs") as typeof import("node:fs");
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
      const { copyFileSync } = require("node:fs") as typeof import("node:fs");
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
 * The responder is non-destructive: if a human answers first (via SSE), the
 * pendingUiResponses entry resolves and our late response is a no-op.
 */
function attachAutoResponder(
  wrapper: AgentSessionWrapper,
  inputTimeoutMs: number,
): UiResponder {
  let active = true;
  const timers: Set<ReturnType<typeof setTimeout>> = new Set();

  const unsubscribe = wrapper.onEvent((event: { type?: string; method?: string; id?: string; title?: string; options?: string[] }) => {
    if (!active || event.type !== "extension_ui_request") return;
    if (!event.id || !event.method) return;
    const method = event.method;
    if (method !== "select" && method !== "confirm" && method !== "input") return;

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
  workDir: string;
  files?: Record<string, string>;
  filePackagePath?: string;
  mode: "host" | "sandbox";
  model?: { provider: string; modelId: string };
  timeoutMs: number;
  inputTimeoutMs: number;
  stopContainer: boolean;
  ownerId: number;
  containerId?: number;
  projectId?: number;
}

export async function runBatchTask(options: RunTaskOptions): Promise<void> {
  const { taskId } = options;
  let wrapper: AgentSessionWrapper | undefined;
  let responder: UiResponder | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    updateTask(taskId, { state: "running", startedAt: Date.now() });

    // 1. Prepare working directory
    const actualWorkDir = prepareWorkDir(options.workDir);
    updateTask(taskId, { actualWorkDir });

    // 2. Materialize files
    if (options.files) materializeFiles(actualWorkDir, options.files);
    if (options.filePackagePath) copyPathPackage(actualWorkDir, options.filePackagePath);

    // 3. Start agent session
    const sessionId = `batch-${taskId.slice(0, 8)}-${Date.now().toString(36)}`;
    const { session } = await startRpcSession(sessionId, "", actualWorkDir, {
      ownerId: options.ownerId,
      mode: options.mode,
      ...(options.model ? { initialModel: options.model } : {}),
      ...(options.containerId !== undefined ? { containerId: options.containerId } : {}),
    });
    wrapper = session;
    const realSessionId = wrapper.sessionId;
    updateTask(taskId, { sessionId: realSessionId });

    // 4. Attach auto-responder for interactive tools
    responder = attachAutoResponder(wrapper, options.inputTimeoutMs);

    // 5. Set up overall timeout
    const abortController = new AbortController();
    timeoutTimer = setTimeout(() => {
      abortController.abort();
    }, options.timeoutMs);

    // 6. Send the prompt (this blocks until the agent settles)
    await wrapper.send({ type: "prompt", content: options.prompt });

    // 7. Collect results — use the wrapper's inner session for stats/messages
    clearTimeout(timeoutTimer);
    responder.stop();

    const inner = (wrapper as unknown as { inner: { getSessionStats(): { tokens: { input: number; output: number; total: number }; toolCalls: number }; sessionManager: { getBranch(): unknown[] }; sessionFile?: string; dispose(): void } }).inner;
    const stats = inner.getSessionStats();
    const messages = inner.sessionManager.getBranch();
    const lastAssistant = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant");
    const finalText =
      (lastAssistant as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
        ?.filter((p) => p.type === "text" && p.text)
        ?.map((p) => p.text ?? "")
        ?.join("\n") ?? "";
    const stopReason = ((lastAssistant as { stopReason?: string } | undefined)?.stopReason) ?? "end_turn";

    const toolCallLog = collectToolCalls(messages);
    const artifacts = scanArtifacts(actualWorkDir);
    const sessionFile = wrapper.sessionFile;

    updateTask(taskId, {
      state: "completed",
      stopReason: normalizeStopReason(stopReason),
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
    const isAbort = e instanceof Error && e.name === "AbortError";
    updateTask(taskId, {
      state: isAbort ? "cancelled" : "failed",
      stopReason: isAbort ? "timeout" : "error",
      endedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    // 8. Cleanup: stop sandbox container if requested
    if (options.stopContainer && options.containerId !== undefined) {
      try {
        const platformModule = await import("@/lib/platform/client");
        await platformModule.platformPost(`/api/v1/containers/${options.containerId}/stop`, "", undefined);
      } catch {
        // Best-effort: container may already be stopped
      }
    }
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
