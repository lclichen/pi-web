/**
 * Deterministic benchmark checks (P0-2).
 *
 * Semantics are ported from pi-lab-training's VerifyEngine (file_exists /
 * file_contains / command_match) so benchmark verdicts mean the same thing
 * the teaching flow already trusts, plus transcript-level checks that judge
 * *harness behavior* (tool usage discipline) rather than file outcomes —
 * that is what lets a run blame the framework slice or the model slice.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CheckContext {
  /** Workspace root the agent operated on. */
  cwd: string;
  /** Session transcript (AgentMessage[]) from the harness. */
  messages: unknown[];
}

export type Check =
  | { kind: "file_exists"; path: string; name?: string }
  | { kind: "file_not_exists"; path: string; name?: string }
  | { kind: "file_contains"; path: string; text?: string; regex?: string; name?: string }
  | { kind: "file_not_contains"; path: string; text?: string; regex?: string; name?: string }
  | { kind: "node_script"; script: string; name?: string }
  /**
   * Run a command (argv array, no shell) in the workspace; pass when exit
   * code and stdout match. Prefer node_script on cross-platform suites.
   */
  | { kind: "command"; argv: string[]; expectExit?: number; stdoutRegex?: string; name?: string }
  | { kind: "plan_saved"; name?: string }
  | { kind: "todo_used"; minCalls?: number; maxCalls?: number; forbidErrors?: boolean; name?: string }
  | { kind: "todo_all_completed"; name?: string }
  | { kind: "tool_called"; tool: string; minCalls?: number; maxCalls?: number; name?: string };

export interface CheckResult {
  name: string;
  kind: string;
  pass: boolean;
  detail: string;
}

export function checkName(check: Check, index: number): string {
  return check.name ?? `${check.kind}[${index}]`;
}

function readIfExists(cwd: string, path: string): string | null {
  try {
    return readFileSync(join(cwd, path), "utf8");
  } catch {
    return null;
  }
}

function contains(content: string, check: { text?: string; regex?: string }): boolean {
  if (check.text !== undefined && !content.includes(check.text)) return false;
  if (check.regex !== undefined && !new RegExp(check.regex, "m").test(content)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Transcript helpers — structural access to pi session messages.
// ---------------------------------------------------------------------------

export interface ToolCallRecord { id: string; name: string; arguments: unknown }
export interface ToolResultRecord { toolCallId: string; name: string; isError: boolean; details: unknown; text: string }

export function collectToolEvents(messages: unknown[]): {
  calls: ToolCallRecord[];
  results: ToolResultRecord[];
} {
  const calls: ToolCallRecord[] = [];
  const results: ToolResultRecord[] = [];
  for (const message of messages) {
    const msg = message as {
      role?: string;
      content?: Array<{ type?: string; id?: string; name?: string; text?: string }>;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      details?: unknown;
    };
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "toolCall" && typeof part.name === "string") {
          calls.push({ id: String(part.id), name: part.name, arguments: (part as { arguments?: unknown }).arguments });
        }
      }
    } else if (msg.role === "toolResult" && typeof msg.toolName === "string") {
      const text = Array.isArray(msg.content)
        ? msg.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
        : "";
      results.push({
        toolCallId: String(msg.toolCallId),
        name: msg.toolName,
        isError: msg.isError === true,
        details: msg.details,
        text,
      });
    }
  }
  return { calls, results };
}

interface TodoSnapshot { todos: Array<{ status?: string }>; error?: string; noChange?: boolean }

function todoResults(results: ToolResultRecord[]): ToolResultRecord[] {
  return results.filter((r) => r.name === "todo" && r.details && typeof r.details === "object");
}

export function todoMetrics(messages: unknown[]): {
  calls: number;
  errorCalls: number;
  noChangeCalls: number;
  finalSnapshot: TodoSnapshot | null;
  everHadList: boolean;
} {
  const { calls, results } = collectToolEvents(messages);
  const todo = todoResults(results);
  let finalSnapshot: TodoSnapshot | null = null;
  let everHadList = false;
  for (const r of todo) {
    const d = r.details as TodoSnapshot;
    if (Array.isArray(d.todos)) {
      finalSnapshot = d;
      if (d.todos.length > 0) everHadList = true;
    }
  }
  return {
    calls: calls.filter((c) => c.name === "todo").length,
    errorCalls: todo.filter((r) => r.isError || (r.details as TodoSnapshot).error).length,
    noChangeCalls: todo.filter((r) => (r.details as TodoSnapshot).noChange === true).length,
    finalSnapshot,
    everHadList,
  };
}

// ---------------------------------------------------------------------------
// Check execution
// ---------------------------------------------------------------------------

export async function runCheck(check: Check, ctx: CheckContext): Promise<CheckResult> {
  const fail = (detail: string): CheckResult => ({ name: "", kind: check.kind, pass: false, detail });
  const pass = (detail: string): CheckResult => ({ name: "", kind: check.kind, pass: true, detail });

  switch (check.kind) {
    case "file_exists": {
      const full = join(ctx.cwd, check.path);
      return existsSync(full)
        ? pass(`${check.path} exists`)
        : fail(`${check.path} not found`);
    }
    case "file_not_exists":
      return existsSync(join(ctx.cwd, check.path))
        ? fail(`${check.path} should not exist`)
        : pass(`${check.path} absent`);
    case "file_contains":
    case "file_not_contains": {
      const content = readIfExists(ctx.cwd, check.path);
      if (content === null) return fail(`${check.path} not found`);
      const has = contains(content, check);
      if (check.kind === "file_contains") {
        return has ? pass(`${check.path} matches`) : fail(`${check.path} does not contain ${check.text ?? `/${check.regex}/`}`);
      }
      return has ? fail(`${check.path} still contains ${check.text ?? `/${check.regex}/`}`) : pass(`${check.path} clean`);
    }
    case "node_script": {
      try {
        await execFileAsync(process.execPath, ["-e", check.script], { cwd: ctx.cwd, timeout: 30_000 });
        return pass("node script exited 0");
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return fail(`node script failed: ${err.stderr || err.stdout || err.message}`);
      }
    }
    case "command": {
      try {
        const { stdout } = await execFileAsync(check.argv[0], check.argv.slice(1), {
          cwd: ctx.cwd,
          timeout: 60_000,
        });
        if (check.stdoutRegex && !new RegExp(check.stdoutRegex, "m").test(stdout)) {
          return fail(`stdout does not match /${check.stdoutRegex}/: ${stdout.slice(0, 200)}`);
        }
        return pass(`exit 0${check.stdoutRegex ? `, stdout matches` : ""}`);
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
        if (check.expectExit !== undefined && err.code === check.expectExit) return pass(`exit ${err.code} as expected`);
        return fail(`command failed (code ${err.code}): ${err.stderr || err.stdout || err.message}`);
      }
    }
    case "plan_saved": {
      const dir = join(ctx.cwd, ".pi", "plans");
      if (!existsSync(dir)) return fail(".pi/plans not created — plan_save never ran");
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      if (files.length === 0) return fail(".pi/plans has no markdown files");
      for (const f of files) {
        const content = readFileSync(join(dir, f), "utf8");
        if (/^- \[[ x]\]/m.test(content)) {
          return pass(`${f} contains checkbox steps`);
        }
      }
      return fail("plan file has no `- [ ]` / `- [x]` steps");
    }
    case "todo_used": {
      const m = todoMetrics(ctx.messages);
      const min = check.minCalls ?? 1;
      if (m.calls < min) return fail(`todo called ${m.calls}x, expected >= ${min}`);
      if (check.maxCalls !== undefined && m.calls > check.maxCalls) {
        return fail(`todo called ${m.calls}x, expected <= ${check.maxCalls} (chatty tool use)`);
      }
      if (check.forbidErrors && m.errorCalls > 0) {
        return fail(`${m.errorCalls} todo call(s) returned validation errors (schema/state misuse)`);
      }
      return pass(`todo used ${m.calls}x, ${m.errorCalls} error(s), ${m.noChangeCalls} no-op(s)`);
    }
    case "todo_all_completed": {
      const m = todoMetrics(ctx.messages);
      if (!m.everHadList) return fail("todo tool never held a list — discipline not exercised");
      if (m.finalSnapshot === null) return fail("no todo snapshot found in transcript");
      const todos = m.finalSnapshot.todos;
      // Auto-clear on all-complete leaves an empty list; either that or an
      // all-completed snapshot satisfies the check.
      const allDone = todos.length === 0 || todos.every((t) => t.status === "completed");
      return allDone
        ? pass(todos.length === 0 ? "final list auto-cleared after completion" : "all steps completed")
        : fail(`final list has ${todos.filter((t) => t.status !== "completed").length} unfinished step(s)`);
    }
    case "tool_called": {
      const { calls } = collectToolEvents(ctx.messages);
      const n = calls.filter((c) => c.name === check.tool).length;
      const min = check.minCalls ?? 1;
      if (n < min) return fail(`${check.tool} called ${n}x, expected >= ${min}`);
      if (check.maxCalls !== undefined && n > check.maxCalls) {
        return fail(`${check.tool} called ${n}x, expected <= ${check.maxCalls}`);
      }
      return pass(`${check.tool} called ${n}x`);
    }
  }
}

export async function runChecks(checks: Check[], ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (let i = 0; i < checks.length; i++) {
    const result = await runCheck(checks[i], ctx);
    result.name = checkName(checks[i], i);
    results.push(result);
  }
  return results;
}
