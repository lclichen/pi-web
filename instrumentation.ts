export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Start the Local-Agent relay (WebSocket on a separate port). Only start in
  // an actual server phase — never during `next build` (which also invokes
  // register()). A failure here must NOT break pi-web: the rest of the UI works
  // fine without the relay, so we log and move on.
  const phase = process.env.NEXT_PHASE;
  const isServerPhase =
    phase === "phase-production-server" || phase === "phase-development-server" || !phase;
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
  const { closeAllAgentEventStreams } = await import("@/lib/agent-event-stream");
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
