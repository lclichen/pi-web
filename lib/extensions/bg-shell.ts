/**
 * Re-export shim for the amedac-core background-shell extension (single
 * source of truth in pi-config/agent/extensions/amedac-core — same package
 * the pi CLI ships; see that file for the design notes).
 */
export {
  makeBgShellExtension,
  registerBgChannel,
  listBgTasks,
  stopBgTask,
  BG_TASKS_WIDGET_KEY,
  type BgExecChannel,
  type BgTask,
} from "../../pi-config/agent/extensions/amedac-core/src/bg-shell.ts";
