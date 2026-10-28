/**
 * Provider session-affinity metadata (merged from the user's standalone
 * before_provider_request plugin — now part of every amedac-core session, so
 * CLI and WebUI share it and sandbox sessions no longer carry a private copy).
 *
 * Two channels:
 *   · HTTP headers on EVERY provider — x-session-id / session_id /
 *     x-session-affinity are the widely used gateway affection/affinity
 *     conventions (nginx/istio/LiteLLM passthrough), so a request stays
 *     pinned to the session's worker/cache.
 *   · `litellm_session_id` body field for LiteLLM-backed providers
 *     (amedac.ai / litellm) — LiteLLM's own per-session accounting key.
 *     Kept provider-gated: unknown body fields would be forwarded verbatim
 *     to strict upstreams.
 */
import type {
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Body-field providers (LiteLLM convention). Headers apply to all. */
const SESSION_FIELD_PROVIDERS = new Set(["amedac.ai", "litellm"]);

function currentSessionId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager?.getSessionId();
}

export function makeProviderSessionIdExtension() {
  return (pi: ExtensionAPI): void => {
    // Handlers mutate the headers object in place; the return value (if any)
    // is ignored by the runner.
    pi.on("before_provider_headers", (event: BeforeProviderHeadersEvent, ctx: ExtensionContext) => {
      const sessionId = currentSessionId(ctx);
      if (!sessionId) return;
      event.headers["x-session-id"] = sessionId;
      event.headers["session_id"] = sessionId;
      event.headers["x-session-affinity"] = sessionId;
    });

    pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;
      const provider = ctx.model?.provider;
      if (!provider || !SESSION_FIELD_PROVIDERS.has(provider)) return payload;
      const sessionId = currentSessionId(ctx);
      if (!sessionId) {
        console.warn("missing session id");
        return payload;
      }
      return {
        ...payload,
        litellm_session_id: sessionId,
      };
    });
  };
}
