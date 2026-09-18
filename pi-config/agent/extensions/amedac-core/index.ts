/**
 * amedac-core — CLI 与 WebUI 共享的核心会话扩展（单一事实源）。
 *
 * Registers: todo · plan_save · enter/exit_plan_mode (+ /plan, /plan-exit,
 * /todo-clear commands). State lives in session entries and workspace files
 * only, so the extension behaves identically in the pi CLI (TUI) and pi-web
 * (RPC) — widgets branch on ctx.mode to render friendly TUI lines vs the
 * JSON payload the WebUI capsule parses.
 *
 * Distribution: this directory ships in the offline package's pi-config
 * template (install-pi-config.sh links/copies it into ~/.pi/agent/extensions).
 * pi-web consumes the SAME source via the re-export shims in
 * lib/extensions/* for its inline injection (bench) and UI imports; its
 * sessions load this package through the global agent dir (with a
 * source-layout fallback in session-restore-options.ts), never both paths at
 * once.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeContextStatusExtension } from "./src/context-status.ts";
import { makePlanModeExtension } from "./src/plan-mode.ts";
import { makeSessionPlanExtension } from "./src/session-plan.ts";
import { makeTodoExtension } from "./src/todo.ts";

export { makeContextStatusExtension, makePlanModeExtension, makeSessionPlanExtension, makeTodoExtension };

export default function amedacCore(pi: ExtensionAPI): void {
  makeTodoExtension()(pi);
  makeSessionPlanExtension()(pi);
  makePlanModeExtension()(pi);
  makeContextStatusExtension()(pi);
}
