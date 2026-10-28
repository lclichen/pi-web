/**
 * amedac-core — CLI 与 WebUI 共享的核心会话扩展（单一事实源）。
 *
 * Registers: todo · plan_save · enter/exit_plan_mode (+ /plan, /plan-exit,
 * /todo-clear commands) · path-guard · bg-shell · sandbox tools（条件）.
 * State lives in session entries and workspace files only, so the extension
 * behaves identically in the pi CLI (TUI) and pi-web (RPC) — widgets branch
 * on ctx.mode to render friendly TUI lines vs the JSON payload the WebUI
 * capsule parses.
 *
 * Sandbox tools activate for the CLI when the launch dir (or SANDBOX_* env)
 * carries sandbox config (src/sandbox/config-bridge.sandboxConfigPresent);
 * pi-web instead injects the same factory inline per sandbox session, so
 * non-sandbox sessions in the server process never load it.
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
import { makePathGuardExtension } from "./src/path-guard.ts";
import { makePlanModeExtension } from "./src/plan-mode.ts";
import { makeSessionPlanExtension } from "./src/session-plan.ts";
import { makeTodoExtension } from "./src/todo.ts";
import { makeBgShellExtension } from "./src/bg-shell.ts";
import { makeSandboxToolsExtension } from "./src/sandbox/index.ts";
import { sandboxConfigPresent } from "./src/sandbox/config-bridge.ts";

export {
  makeBgShellExtension,
  makeContextStatusExtension,
  makePathGuardExtension,
  makePlanModeExtension,
  makeSessionPlanExtension,
  makeTodoExtension,
};
export { makeSandboxToolsExtension, sandboxConfigPresent };

export default function amedacCore(pi: ExtensionAPI): void {
  makeTodoExtension()(pi);
  makeSessionPlanExtension()(pi);
  makePlanModeExtension()(pi);
  // e9aa936e 落地时漏了这一行——path-guard 只有 import/export 从未注册，
  // CLI/WebUI 的写护栏（策略页背后）实际一直没生效。
  makePathGuardExtension()(pi);
  makeContextStatusExtension()(pi);
  makeBgShellExtension()(pi);
  // CLI 路径：进程启动目录带沙盒配置才注册（pi-web 的进程 cwd 是仓库
  // 根，永不命中；其沙盒会话经内联工厂注入同一份源码）。
  if (sandboxConfigPresent(process.cwd())) {
    makeSandboxToolsExtension().factory(pi);
  }
}
