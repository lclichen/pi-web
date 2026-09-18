/**
 * Re-export shim — the implementation lives in
 * pi-config/agent/extensions/amedac-core/src/todo.ts (single source of truth
 * shared with the pi CLI distribution). Kept so pi-web UI imports
 * (todo-protocol consumers) and the bench harness's inline injection keep
 * their module paths; production pi-web sessions load amedac-core through
 * the global agent dir instead (see session-restore-options.ts).
 */
export * from "../../pi-config/agent/extensions/amedac-core/src/todo.ts";
