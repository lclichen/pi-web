/**
 * Force-exit shutdown wiring (Ctrl+C used to hang, see instrumentation.ts).
 *
 * Next's graceful shutdown waits for open HTTP connections to finish; the UI's
 * SSE streams (agent status, terminal output, running sessions) never finish,
 * so with a browser tab open the process only died once the user closed or
 * refreshed the page. This module gives the graceful path a brief window,
 * then drops owned servers and force-exits.
 *
 * Dependency-injected (exit/schedule) so the semantics are unit-testable on
 * any platform — real signal delivery differs on win32, production runs on
 * Linux where SIGINT/SIGTERM behave normally.
 */

export interface ShutdownDeps {
  /** Close owned servers/sockets (relay WS + its HTTP connections). */
  closeServers: () => void;
  /** Test seam for process.exit. */
  exit?: (code: number) => void;
  /** Test seam for the force-exit timer. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Grace window before the force exit (ms). */
  delayMs?: number;
}

/** Exit codes follow the shell convention 128 + signal number. */
export function signalExitCode(signal: string): number {
  return signal === "SIGTERM" ? 143 : 130;
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  const { closeServers } = deps;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const delayMs = deps.delayMs ?? 2_000;
  let fired = false;
  return (signal: string) => {
    if (fired) return; // once: a second Ctrl+C means "kill it now"
    fired = true;
    try {
      closeServers();
    } catch {
      // best-effort: never let cleanup block the exit path
    }
    schedule(() => exit(signalExitCode(signal)), delayMs);
  };
}
