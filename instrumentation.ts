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
}
