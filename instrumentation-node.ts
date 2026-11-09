import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { ensureEventLoopMonitor } from "@/lib/perf-stats";
import { installServerLogTee } from "@/lib/server-log";

/**
 * Process-level resilience (dev 批次1): the whole app is one Node process, so
 * a stray unhandled rejection used to crash every user's session at once
 * (Node ≥15 default) and left nothing behind but lost stdout. Both handlers
 * log (tee'd into <dataDir>/logs) and keep serving — availability beats a
 * clean exit here because there is no supervisor on the deploy box.
 * PI_WEB_EXIT_ON_UNCAUGHT=1 restores fail-fast for local debugging.
 */
function registerCrashHandlers(): void {
  const guard = Symbol.for("pi-web.crashHandlers");
  const global = globalThis as Record<symbol, boolean | undefined>;
  if (global[guard]) return;
  global[guard] = true;

  process.on("unhandledRejection", (reason) => {
    console.error("[pi-web] unhandled rejection:", reason instanceof Error ? reason.stack : reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[pi-web] uncaught exception:", error instanceof Error ? error.stack : error);
    if (process.env.PI_WEB_EXIT_ON_UNCAUGHT === "1") {
      closeAllAgentEventStreams();
      process.exit(1);
    }
  });
}

export async function registerNodeInstrumentation(): Promise<void> {
  configureHttpDispatcher();
  installServerLogTee();
  registerCrashHandlers();
  ensureEventLoopMonitor();

  // Start the Local-Agent relay (WebSocket on a separate port). Only start in
  // an actual server phase — never during `next build` (which also invokes
  // register()). A failure here must NOT break pi-web: the rest of the UI works
  // fine without the relay, so we log and move on.
  const phase = process.env.NEXT_PHASE;
  const isServerPhase = phase === "phase-production-server" || phase === "phase-development-server" || !phase;
  if (isServerPhase) {
    // Prewarm the pi SDK import (upstream `6425d0d`): the first route that
    // touches @earendil-works/pi-coding-agent otherwise pays seconds of module
    // loading inside the request (worst on Windows/cold deploys).
    void import("@earendil-works/pi-coding-agent").catch(() => {});
  }
  if (process.env.PI_RELAY_DISABLE !== "1" && isServerPhase) {
    try {
      const { startRelayServer } = await import("@/lib/relay/ws-server");
      await startRelayServer();
    } catch (err) {
      console.error("[relay] failed to start agent relay server:", err);
    }
  }

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();

  if (process.env.PI_RELAY_DISABLE !== "1" && isServerPhase) {
    // Full handler: SSE + relay sockets + force exit after grace window.
    const { createShutdownHandler } = await import("@/lib/shutdown");
    const shutdown = createShutdownHandler({
      closeServers: () => {
        shutdownStreams();
        const relay = globalThis.__piRelayServer;
        if (relay) {
          relay.server.close();
          relay.server.closeAllConnections?.();
        }
      },
    });
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } else {
    // Minimal path (relay disabled or non-server phase): just close SSE.
    process.on("SIGINT", shutdownStreams);
    process.on("SIGTERM", shutdownStreams);
  }
}
