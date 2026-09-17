/**
 * Shared todo protocol (zero-dependency, safe for client components).
 *
 * The extension (todo.ts) and the WebUI (ChatWindow / ChatStatusWidget)
 * agree on this payload shape for the "todo-list" widget line. Keeping it in
 * a dependency-free module lets both sides import the same types/helpers
 * without dragging the pi SDK into the client bundle.
 *
 * v2 shape (2026-09): full-list write semantics modeled on Claude Code's
 * TodoWrite and codex's update_plan —
 *   - one status enum: pending | in_progress | completed (set, never flip)
 *   - ids are assigned by the extension and stay stable across rewrites
 *     (matched by content), so the UI highlight does not jump around
 *   - activeForm is an optional present-continuous label ("running tests")
 */
/** Widget key the extension publishes on; the WebUI reserves this key. */
export const TODO_WIDGET_KEY = "todo-list";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  /** Present-continuous label shown while this step runs. */
  activeForm?: string;
}

export interface TodoWidgetPayload {
  todos: TodoItem[];
}

/** Encode the widget line published on the "todo-list" key. */
export function encodeTodoWidget(todos: TodoItem[]): string {
  return JSON.stringify({ todos } satisfies TodoWidgetPayload);
}

/**
 * Parse a widget line back into items. Returns [] for anything malformed
 * (the widget channel is best-effort; a bad line must never break the UI).
 */
export function parseTodoWidgetLine(line: string | undefined): TodoItem[] {
  if (!line) return [];
  try {
    const parsed = JSON.parse(line) as Partial<TodoWidgetPayload>;
    if (!parsed || !Array.isArray(parsed.todos)) return [];
    const todos: TodoItem[] = [];
    for (const raw of parsed.todos) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Partial<TodoItem>;
      if (typeof item.id !== "number" || typeof item.content !== "string") continue;
      const status: TodoStatus =
        item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
      todos.push({
        id: item.id,
        content: item.content,
        status,
        ...(item.activeForm === undefined || item.activeForm === null
          ? {}
          : { activeForm: String(item.activeForm) }),
      });
    }
    return todos;
  } catch {
    return [];
  }
}
