/**
 * In-process benchmark harness (P0-2).
 *
 * Drives a real pi AgentSession (same SDK entry points pi-web's rpc-manager
 * uses) inside an isolated temp workspace, with the SAME inline extensions
 * the product sessions get (todo + session-plan). That is what makes this a
 * framework benchmark rather than a raw model benchmark: the harness slice
 * under test includes extension loading, tool exposure, prompt-snippet
 * injection and the widget channel.
 *
 * Modeled on pi/packages/evals/src/pi-harness.ts (upstream), adapted to:
 *   - accept extensionFactories + a task fixture
 *   - collect transcript for behavioral checks (todo discipline etc.)
 *   - enforce a per-task wall-clock budget via AbortController
 *
 * Real-model only: callers must pass provider/model (or PI_PROVIDER/PI_MODEL).
 * CI never invokes this module — bench.test.mjs covers the model-free slice.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { makeSessionPlanExtension } from "../lib/extensions/session-plan.ts";
import { makeTodoExtension } from "../lib/extensions/todo.ts";
import type { BenchTask } from "./tasks.ts";

export interface ModelSelection {
  provider: string;
  id: string;
}

export function resolveModelSelection(
  explicit: ModelSelection | undefined,
  environment: Record<string, string | undefined> = process.env,
): ModelSelection {
  const provider = (explicit?.provider ?? environment.PI_PROVIDER)?.trim();
  const id = (explicit?.id ?? environment.PI_MODEL)?.trim();
  if (!provider || !id) {
    throw new Error("Set --provider/--model (or PI_PROVIDER and PI_MODEL) to run the benchmark.");
  }
  return { provider, id };
}

/** The extension stack product sessions run; the benchmark runs the same. */
export function benchExtensionFactories(): InlineExtension[] {
  return [makeTodoExtension(), makeSessionPlanExtension()];
}

export interface BenchRunResult {
  taskId: string;
  pass: boolean;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCalls: number;
  };
  messages: unknown[];
  error?: string;
  /** Session JSONL snapshot path (kept only when KEEPBENCH=1). */
  sessionFile?: string;
}

/**
 * Run one task against one model. Workspace is a throwaway temp dir seeded
 * with task.files; `afterRun` runs inside the workspace's lifetime (before
 * cleanup) so file checks can read what the agent actually produced.
 * Never throws for agent-level failures — they are reported in `error` so
 * the matrix keeps going.
 */
export async function runBenchTask(
  task: BenchTask,
  selection: ModelSelection,
  options: {
    extensionFactories?: InlineExtension[];
    keepArtifacts?: boolean;
    afterRun?: (ctx: { cwd: string; messages: unknown[]; sessionFile?: string }) => void | Promise<void>;
  } = {},
): Promise<BenchRunResult> {
  const startedAt = performance.now();
  const root = await mkdtemp(join(tmpdir(), "pi-web-bench-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  let session: AgentSession | undefined;
  let sessionFile: string | undefined;

  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    for (const [path, content] of Object.entries(task.files)) {
      const full = join(cwd, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }

    const modelRuntime = await ModelRuntime.create();
    const model = modelRuntime.getModel(selection.provider, selection.id);
    if (!model) throw new Error(`Model not found: ${selection.provider}/${selection.id}`);

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        extensionFactories: options.extensionFactories ?? benchExtensionFactories(),
      },
    });
    const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
    session = (
      await createAgentSessionFromServices({ services, sessionManager, model })
    ).session;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), task.timeoutMs ?? 300_000);
    let error: string | undefined;
    try {
      abort.signal.addEventListener("abort", () => void session?.abort(), { once: true });
      await session.prompt(task.prompt);
      const last = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      if (last && last.stopReason !== "stop") {
        error = last.errorMessage ?? `agent run ended with stopReason=${last.stopReason}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timeout);
    }

    const stats = session.getSessionStats();
    const file = sessionManager.getSessionFile() ?? undefined;
    if (options.afterRun) {
      try {
        await options.afterRun({ cwd, messages: session.messages as unknown[], sessionFile: file });
      } catch (e) {
        error = error ?? `afterRun hook failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return {
      taskId: task.id,
      pass: error === undefined,
      durationMs: performance.now() - startedAt,
      usage: {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
        toolCalls: stats.toolCalls,
      },
      messages: session.messages as unknown[],
      error,
      sessionFile: file ?? undefined,
    };
  } catch (e) {
    return {
      taskId: task.id,
      pass: false,
      durationMs: performance.now() - startedAt,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0 },
      messages: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    try {
      session?.dispose();
    } catch {
      // dispose is best-effort
    }
    if (!options.keepArtifacts) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}
