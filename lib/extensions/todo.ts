/**
 * Session TODO extension (adapted from the pi todo.ts sample).
 *
 * - Registers a batch `todo` tool (list / add / toggle / clear) so the model
 *   can maintain a progress list for multi-step tasks.
 * - State rides session entries (tool-result details + a custom entry for
 *   manual clears), so branching restores the right TODO set automatically.
 * - Publishes the live list to the web UI through the RPC widget channel:
 *   setWidget("todo-list", [JSON.stringify({todos})]) — ChatStatusWidget parses
 *   that payload for the 进程 section; the generic extension-widget bar filters
 *   the key out so the raw JSON never shows.
 * - A short before_agent_start prompt block nudges the model to actually use
 *   the tool on multi-step work.
 */
import { defineTool, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";

export const TODO_WIDGET_KEY = "todo-list";
const CLEAR_TYPE = "todo-clear";

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

interface TodoState {
  todos: TodoItem[];
  nextId: number;
}

interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: TodoItem[];
  nextId: number;
  error?: string;
  results?: Array<{ ok: boolean; id?: number; text?: string; done?: boolean; message?: string }>;
}

interface TodoArgs {
  action: "list" | "add" | "toggle" | "clear";
  texts?: string[];
  ids?: number[];
}

const textBlock = (s: string) => ({ type: "text" as const, text: s });

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  texts: Type.Optional(Type.Array(Type.String(), { description: "Todo texts (for add, >=1)" })),
  ids: Type.Optional(Type.Array(Type.Number(), { description: "Todo IDs (for toggle, >=1)" })),
});

function listTodos(state: TodoState) {
  return {
    content: [textBlock(
      state.todos.length
        ? state.todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
        : "No todos",
    )],
    details: { action: "list", todos: [...state.todos], nextId: state.nextId } satisfies TodoDetails,
  };
}

function addTodos(texts: string[] | undefined, state: TodoState) {
  if (!texts || texts.length === 0) {
    return {
      content: [textBlock("Error: texts required (non-empty) for add")],
      details: { action: "add", todos: [...state.todos], nextId: state.nextId, error: "texts required (non-empty)" } satisfies TodoDetails,
    };
  }
  const results: NonNullable<TodoDetails["results"]> = [];
  for (const text of texts) {
    const todo: TodoItem = { id: state.nextId++, text, done: false };
    state.todos.push(todo);
    results.push({ ok: true, id: todo.id, text });
  }
  return {
    content: [textBlock(`Added ${results.length}: ${results.map((r) => `#${r.id} ${r.text}`).join(", ")}`)],
    details: { action: "add", todos: [...state.todos], nextId: state.nextId, results } satisfies TodoDetails,
  };
}

function toggleTodos(ids: number[] | undefined, state: TodoState) {
  if (!ids || ids.length === 0) {
    return {
      content: [textBlock("Error: ids required (non-empty) for toggle")],
      details: { action: "toggle", todos: [...state.todos], nextId: state.nextId, error: "ids required (non-empty)" } satisfies TodoDetails,
    };
  }
  const results: NonNullable<TodoDetails["results"]> = [];
  for (const id of ids) {
    const todo = state.todos.find((t) => t.id === id);
    if (!todo) {
      results.push({ ok: false, id, message: `#${id} not found` });
      continue;
    }
    todo.done = !todo.done;
    results.push({ ok: true, id: todo.id, done: todo.done });
  }
  const okCount = results.filter((r) => r.ok).length;
  const summary = results.map((r) => (r.ok ? `#${r.id}${r.done ? "✓" : "○"}` : `#${r.id}✗`)).join(", ");
  if (state.todos.length > 0 && state.todos.every((t) => t.done)) {
    const count = state.todos.length;
    state.todos = [];
    state.nextId = 1;
    return {
      content: [textBlock(`Toggled ${okCount}: ${summary}\n${count} todos completed! Auto-cleared.`)],
      details: { action: "clear", todos: [], nextId: 1, results } satisfies TodoDetails,
    };
  }
  return {
    content: [textBlock(`Toggled ${okCount}: ${summary}`)],
    details: { action: "toggle", todos: [...state.todos], nextId: state.nextId, results } satisfies TodoDetails,
  };
}

function clearTodos(state: TodoState) {
  const count = state.todos.length;
  state.todos = [];
  state.nextId = 1;
  return {
    content: [textBlock(`Cleared ${count} todos`)],
    details: { action: "clear", todos: [], nextId: 1 } satisfies TodoDetails,
  };
}

function executeTodo(params: TodoArgs, state: TodoState) {
  switch (params.action) {
    case "list": return listTodos(state);
    case "add": return addTodos(params.texts, state);
    case "toggle": return toggleTodos(params.ids, state);
    case "clear": return clearTodos(state);
  }
}

/** Rebuild state by replaying the branch's todo tool results / clear entries. */
function reconstructState(ctx: ExtensionContext, state: TodoState): void {
  state.todos = [];
  state.nextId = 1;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CLEAR_TYPE) {
      state.todos = [];
      state.nextId = 1;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
    const details = msg.details as TodoDetails | undefined;
    if (details) {
      state.todos = details.todos;
      state.nextId = details.nextId;
    }
  }
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
      setWidget(TODO_WIDGET_KEY, [JSON.stringify({ todos: state.todos })]);
    } catch {
      // The widget channel is best-effort; tool results still carry state.
    }
  };

  return (pi: ExtensionAPI): void => {
    pi.on("session_start", async (_event, ctx) => {
      reconstructState(ctx, state);
      publishWidget(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      reconstructState(ctx, state);
      publishWidget(ctx);
    });

    pi.registerTool(defineTool({
      name: "todo",
      label: "Todo",
      description:
        "Manage the session TODO list (batch). Actions: list, add (texts[]), toggle (ids[]), clear. " +
        "Use it to break multi-step tasks into steps and mark progress; the UI status capsule shows the current step.",
      promptSnippet: "todo — manage the session TODO list: add steps, toggle done by id, list, clear",
      promptGuidelines: [
        "对于超过两步的任务，先用 todo add 把任务拆解成步骤清单；每完成一步立即 toggle 对应 id（全部完成后列表自动清空）。界面的状态胶囊会实时展示当前步骤，无需在回复中复述整个清单。",
      ],
      parameters: TodoParams,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = executeTodo(params, state);
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
