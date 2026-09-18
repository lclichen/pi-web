/**
 * Session TODO extension — v2, full-list write semantics.
 *
 * Redesigned (2026-09) after Claude Code's TodoWrite and codex's update_plan:
 * both major harnesses converged on "pass the complete list every call, set
 * statuses instead of flipping them", which is measurably easier for models
 * than the old add/toggle batch tool (toggle forced the model to track hidden
 * state; there was no in_progress; all-done auto-clear was surprising).
 *
 * Contract:
 * - One tool, one parameter: the complete updated list. Replaces the previous
 *   list entirely. There is no list action — every result echoes the stored
 *   list with ids, so the model can always see (and self-correct) the state.
 * - status: pending | in_progress | completed. At most one in_progress
 *   (violation is an in-band error that includes the current list).
 * - ids are assigned by the extension and stay stable across rewrites
 *   (matched by content), so the UI highlight does not jump around.
 * - Identical rewrites get a "No change" response (anti-loop guard, borrowed
 *   from rpiv-todo). All steps completed → the list auto-clears.
 * - State rides session entries (tool-result details snapshots), so branching
 *   and /reload restore the right list without any disk writes; legacy v1
 *   details ({text, done}) are migrated on replay.
 * - The live list is published to the WebUI through the widget channel:
 *   setWidget("todo-list", [encodeTodoWidget(items)]) — ChatWindow parses
 *   that payload for the 进程 section; the generic extension-widget bar
 *   filters the key out so the raw JSON never shows.
 */
import { defineTool, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  encodeTodoWidget,
  type TodoItem,
  type TodoStatus,
  TODO_WIDGET_KEY,
} from "./todo-protocol.ts";
import { buildReminderMessage } from "./reminder-channel.ts";

export { TODO_WIDGET_KEY };
export type { TodoItem, TodoStatus };

const CLEAR_TYPE = "todo-clear";
const MAX_ITEMS = 30;

/**
 * CC-style double-threshold todo nudge (#2): remind the model when it has
 * produced N assistant turns without a todo write AND without a recent
 * reminder, while a non-empty list with unfinished items exists. Both
 * thresholds prevent reminder loops.
 */
const NUDGE_ASSISTANT_TURNS = 3;
const VERIFICATION_RE = /verif|测试|test|验证|检查|校验|lint|build|构建/i;

/** Tool-level input item; ids are extension-assigned, never model-supplied. */
interface TodoWriteInput {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

interface TodoState {
  todos: TodoItem[];
  nextId: number;
}

interface TodoDetails {
  todos: TodoItem[];
  nextId: number;
  /** Set when the write was rejected; state is unchanged. */
  error?: string;
  /** Set when the write was a verbatim no-op (anti-loop). */
  noChange?: boolean;
}

const textBlock = (s: string) => ({ type: "text" as const, text: s });

const TodoWriteParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "Step text — short imperative sentence, e.g. 'Run the unit tests'." }),
      status: StringEnum(["pending", "in_progress", "completed"], {
        description: "pending = not started, in_progress = currently working on it, completed = done and verified.",
      }),
      activeForm: Type.Optional(
        Type.String({ description: "Present-continuous label shown while this step runs, e.g. 'running tests'. Optional; defaults to content." }),
      ),
    }),
    { description: "The COMPLETE updated todo list. It replaces the previous list entirely — include every step, not just changes. Send [] to clear." },
  ),
});

function renderList(todos: TodoItem[]): string {
  if (todos.length === 0) return "(empty)";
  return todos
    .map((t) => {
      const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      return `${mark} #${t.id} ${t.content}${t.activeForm && t.activeForm !== t.content ? ` (${t.activeForm})` : ""}`;
    })
    .join("\n");
}

const sameStep = (a: TodoWriteInput, b: TodoWriteInput) =>
  a.content === b.content && a.status === b.status && (a.activeForm ?? "") === (b.activeForm ?? "");

/** Assign stable ids: same content keeps its id across rewrites. */
function mergeIds(incoming: TodoWriteInput[], state: TodoState): TodoItem[] {
  const prevByContent = new Map(state.todos.map((t) => [t.content, t.id]));
  let nextId = state.nextId;
  const items: TodoItem[] = incoming.map((step) => {
    const id = prevByContent.get(step.content) ?? nextId++;
    return { id, content: step.content, status: step.status, ...(step.activeForm ? { activeForm: step.activeForm } : {}) };
  });
  state.nextId = nextId;
  return items;
}

function writeTodos(input: TodoWriteInput[], state: TodoState): {
  content: ReturnType<typeof textBlock>[];
  details: TodoDetails;
  isError?: boolean;
} {
  const fail = (error: string): { content: ReturnType<typeof textBlock>[]; details: TodoDetails; isError: true } => ({
    content: [
      textBlock(`Error: ${error}`),
      textBlock(`Current list (unchanged):\n${renderList(state.todos)}`),
    ],
    details: { todos: [...state.todos], nextId: state.nextId, error },
    isError: true,
  });

  if (input.length > MAX_ITEMS) {
    return fail(`too many steps (${input.length}, max ${MAX_ITEMS}) — keep the list short, usually 3-7 steps`);
  }
  for (const step of input) {
    if (typeof step.content !== "string" || step.content.trim().length === 0) {
      return fail("every step needs a non-empty content");
    }
  }
  const contents = new Set(input.map((s) => s.content));
  if (contents.size !== input.length) {
    return fail("duplicate step content — each step must be unique");
  }
  const inProgress = input.filter((s) => s.status === "in_progress");
  if (inProgress.length > 1) {
    return fail(
      `exactly one step may be in_progress at a time (got ${inProgress.length}: ${inProgress.map((s) => s.content).join("; ")})`,
    );
  }

  const current = state.todos;
  const sameShape =
    current.length === input.length && current.every((t, i) => sameStep(t, input[i]));
  if (sameShape) {
    return {
      content: [textBlock(`No change: the list already matches.\n${renderList(state.todos)}`)],
      details: { todos: [...state.todos], nextId: state.nextId, noChange: true },
    };
  }

  state.todos = mergeIds(input, state);
  if (state.todos.length > 0 && state.todos.every((t) => t.status === "completed")) {
    const count = state.todos.length;
    // Verification nudge (#9, CC experiment semantics): a batch completion of
    // 3+ steps where NO step even mentions verification likely skipped the
    // "tests actually pass" discipline — suggest a verification pass before
    // reporting done.
    const mentionsVerification = input.some((s) => VERIFICATION_RE.test(s.content));
    const nudge =
      count >= 3 && !mentionsVerification
        ? `\n\n[Nudge] You completed ${count} steps at once and none of them mentions verification. Before reporting done, consider re-running the tests/build or spawning a read-only verification subagent to confirm the changes actually work.`
        : "";
    state.todos = [];
    state.nextId = 1;
    return {
      content: [textBlock(`All ${count} steps completed — list cleared. Nice work.${nudge}`)],
      details: { todos: [], nextId: 1 },
    };
  }
  return {
    content: [
      textBlock(
        `Todo list updated (${state.todos.filter((t) => t.status === "completed").length}/${state.todos.length} done):\n${renderList(state.todos)}`,
      ),
    ],
    details: { todos: [...state.todos], nextId: state.nextId },
  };
}

/** Migrate v1 details ({text, done}) and v2 ({content, status}) snapshots. */
function adoptDetails(details: unknown, state: TodoState): void {
  if (!details || typeof details !== "object") return;
  const raw = details as { todos?: unknown; nextId?: unknown };
  if (!Array.isArray(raw.todos)) return;
  const todos: TodoItem[] = [];
  let maxId = 0;
  for (const item of raw.todos) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.content === "string" && typeof t.id === "number") {
      const status = t.status === "in_progress" || t.status === "completed" ? t.status : "pending";
      todos.push({
        id: t.id,
        content: t.content,
        status,
        ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
      });
    } else if (typeof t.text === "string" && typeof t.id === "number") {
      // v1 session: {id, text, done}
      todos.push({ id: t.id, content: t.text, status: t.done ? "completed" : "pending" });
    } else {
      continue;
    }
    maxId = Math.max(maxId, todos[todos.length - 1].id);
  }
  state.todos = todos;
  state.nextId = typeof raw.nextId === "number" && raw.nextId > maxId ? raw.nextId : maxId + 1;
}

/** Rebuild state by replaying the branch's todo tool results / clear entries. */
export function reconstructTodoState(entries: Iterable<{ type: string; customType?: string; message?: unknown }>): TodoState {
  const state: TodoState = { todos: [], nextId: 1 };
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === CLEAR_TYPE) {
      state.todos = [];
      state.nextId = 1;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; toolName?: string; details?: unknown } | undefined;
    if (!msg || msg.role !== "toolResult" || msg.toolName !== "todo") continue;
    adoptDetails(msg.details, state);
  }
  return state;
}

export function makeTodoExtension(): InlineExtension {
  const state: TodoState = { todos: [], nextId: 1 };

  const publishWidget = (ctx: ExtensionContext) => {
    try {
      const setWidget = ctx.ui?.setWidget?.bind(ctx.ui);
      if (!setWidget) return;
      if (state.todos.length === 0) {
        setWidget(TODO_WIDGET_KEY, undefined);
        return;
      }
      // Host-adaptive payload: the WebUI capsule parses the JSON line over
      // RPC; the pi CLI TUI would show it raw — render a friendly checklist
      // instead (same key, same tool results either way).
      if (ctx.mode === "tui") {
        const done = state.todos.filter((t) => t.status === "completed").length;
        setWidget(
          TODO_WIDGET_KEY,
          [
            `todos ${done}/${state.todos.length}`,
            ...state.todos.map((t) => {
              const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
              const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
              return `${mark} ${t.content === label ? label : `${t.content} → ${label}`}`;
            }),
          ],
          { placement: "aboveEditor" },
        );
        return;
      }
      setWidget(TODO_WIDGET_KEY, [encodeTodoWidget(state.todos)]);
    } catch {
      // The widget channel is best-effort; tool results still carry state.
    }
  };

  const rebuild = (ctx: ExtensionContext) => {
    const restored = reconstructTodoState(
      ctx.sessionManager.getBranch() as Iterable<{ type: string; customType?: string; message?: unknown }>,
    );
    state.todos = restored.todos;
    state.nextId = restored.nextId;
  };

  return (pi: ExtensionAPI): void => {
    pi.on("session_start", async (_event, ctx) => {
      rebuild(ctx);
      publishWidget(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      rebuild(ctx);
      publishWidget(ctx);
    });

    // CC-style double-threshold nudge (#2), injected through the shared
    // <system-reminder> attachment channel (request-scoped: the appended
    // message never persists into the session file). Fires only while a list
    // with unfinished items exists, at most once per NUDGE_ASSISTANT_TURNS
    // assistant turns, and only after that many turns without a todo write.
    // A todo write resets both counters — the model is engaged with the list.
    let nudgedAtAssistantCount = Number.NEGATIVE_INFINITY;
    pi.on("context", async (event) => {
      if (state.todos.length === 0 || state.todos.every((t) => t.status === "completed")) return undefined;
      let lastTodoWriteIdx = -1;
      let assistantCount = 0;
      const messages = event.messages as Array<{ role?: string; toolName?: string }>;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "assistant") assistantCount++;
        if (msg.role === "toolResult" && msg.toolName === "todo") lastTodoWriteIdx = i;
      }
      let assistantSinceWrite = 0;
      for (let i = lastTodoWriteIdx + 1; i < messages.length; i++) {
        if (messages[i].role === "assistant") assistantSinceWrite++;
      }
      if (assistantSinceWrite < NUDGE_ASSISTANT_TURNS) return undefined;
      if (assistantCount - nudgedAtAssistantCount < NUDGE_ASSISTANT_TURNS) return undefined;
      nudgedAtAssistantCount = assistantCount;
      const done = state.todos.filter((t) => t.status === "completed").length;
      const reminder = buildReminderMessage([
        `The todo tool hasn't been used in the last ${assistantSinceWrite} assistant turns, but this session tracks a task list (${done}/${state.todos.length} done):\n${renderList(state.todos)}\nIf the current work has drifted from this list, update it with the todo tool (full-list rewrite; exactly one in_progress while working). Do not use the todo tool for trivial single-step work.`,
      ]);
      return { messages: [...event.messages, reminder as unknown as (typeof event.messages)[number]] };
    });

    pi.registerTool(defineTool({
      name: "todo",
      label: "Todo",
      description:
        "Update the session TODO list. Pass the COMPLETE list every time — it replaces the previous list entirely. " +
        "Each step: {content, status, activeForm?} with status pending | in_progress | completed. " +
        "Keep exactly one step in_progress while working on it and mark steps completed as soon as they are done. " +
        "The result echoes the stored list with ids; the UI status capsule shows the current step live.",
      promptSnippet: "todo — rewrite the session TODO list (full list each call; exactly one in_progress while working)",
      // 中文版备查（P0-2 决策：system prompt 统一纯英文，中文保留于此）：
      // 1) 对于预计三步以上的任务，先调用一次 todo 写入完整步骤清单（每步一句祈使句，
      //    通常 3-7 步）；之后每次进展变化都传入整张表，不要只传增量。
      // 2) 任何时刻恰好保持一个 in_progress：开始某步前把它设为 in_progress；
      //    做完立即设为 completed，不要攒到最后批量勾选。
      // 3) 只有验证通过（测试运行、构建成功、结果核对）才能标记 completed；
      //    全部完成后列表会自动清空。
      // 4) 调用 todo 后界面胶囊会实时展示清单，不要在回复中复述整个列表；
      //    两步以内的简单任务不要建清单。
      promptGuidelines: [
        "For any task expected to take more than two steps, call todo ONCE up front with the COMPLETE step list (one imperative sentence per step, usually 3-7 steps); afterwards always send the full list on every progress change — never a delta.",
        "Keep exactly one step in_progress at any moment: set a step to in_progress BEFORE starting it; mark it completed immediately when done — do not batch completions to the end.",
        "Mark a step completed only after verification (tests run, build passes, result checked); once every step is completed the list auto-clears.",
        "After a todo call the UI capsule shows the list live — do not repeat the whole list in replies; do not create a list for trivial tasks of two steps or fewer.",
        "Literal call shape: {\"todos\":[{\"content\":\"Run the unit tests\",\"status\":\"in_progress\"},{\"content\":\"Update the docs\",\"status\":\"pending\"}]} — ids are tool-assigned and echoed in the result.",
      ],
      parameters: TodoWriteParams,
      execute: async (_toolCallId, params: { todos: TodoWriteInput[] }, _signal, _onUpdate, ctx) => {
        const result = writeTodos(params.todos ?? [], state);
        // A write re-engages the list — give the nudge throttle a fresh start.
        nudgedAtAssistantCount = Number.NEGATIVE_INFINITY;
        publishWidget(ctx);
        return result;
      },
    }));

    pi.registerCommand("todo-clear", {
      description: "Clear all todos",
      handler: async (_args, ctx) => {
        state.todos = [];
        state.nextId = 1;
        pi.appendEntry(CLEAR_TYPE, {});
        publishWidget(ctx);
      },
    });
  };
}
