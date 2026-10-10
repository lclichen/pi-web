/**
 * LLM provider auto-provisioning.
 *
 * After the user logs into the sandbox platform, this wires up the agent's LLM
 * provider automatically: it checks whether the platform has granted the user
 * LLM access, fetches (or reuses a cached) gateway API key, and registers the
 * provider with pi via `pi.registerProvider`. The user never has to copy a
 * key by hand.
 *
 * Since the 2026-10 agentgateway migration the platform brokers agentgateway
 * keys (path b). A `llmGateway` block in the extension config bypasses the
 * platform entirely (self-managed gateway / local testing), and registered
 * models send pi's session-affinity headers (compat) so the gateway can
 * attribute requests per pi session.
 *
 * Flow (called from session_start, after ensureAuthenticated):
 *   1. GET /llm/me          -> binding present? no  -> silent skip (not granted)
 *   2. cached llmVirtualKey -> reuse it
 *      else                 -> reveal an active key (or fail gracefully)
 *   3. GET /llm/me/endpoint -> baseUrl
 *   4. GET /llm/models      -> model catalogue
 *   5. pi.registerProvider(llmProvider, { baseUrl, apiKey, api, models })
 *
 * When LLM is not enabled on the platform (501 LLM_NOT_ENABLED; legacy
 * deployments may answer 503) or the user has no binding, this returns false
 * without noise — the container/tools flow is unaffected.
 */
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { PlatformClient, PlatformError } from "./client.ts";
import { saveConfig, type PlatformConfig } from "./config.ts";

/** The provider name we register. Defaults to "amedac.ai", overridable in config. */
function providerName(config: PlatformConfig): string {
  return config.llmProvider ?? "amedac.ai";
}

/**
 * Normalize an OpenAI-compatible base URL. pi expects the `/v1` suffix; the
 * platform's publicBaseUrl may or may not include it.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Map the gateway's model list ({id}) into pi's ProviderModelConfig. The
 * gateway doesn't expose context windows or costs, so we apply conservative
 * defaults — the user can override per-model in pi's models.json if needed.
 *
 * `compat.sendSessionAffinityHeaders` is the load-bearing piece: pi only sends
 * its session headers (`session_id` / `x-session-affinity`, format "openai")
 * when the MODEL opts in, and they are off by default for non-OpenRouter
 * endpoints. agentgateway's session-attribution CEL reads exactly those
 * headers; they are harmless on any other OpenAI-compatible backend (and help
 * prompt-cache affinity). Replaces the old litellm_session_id body injection.
 */
function toProviderModels(models: Array<{ id: string }>): ProviderModelConfig[] {
  const DEFAULT_CONTEXT = 128_000;
  return models.map((m) => ({
    id: m.id,
    name: m.id,
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT,
    maxTokens: DEFAULT_CONTEXT,
    compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai" },
  }));
}

export interface LlmSetupResult {
  ok: boolean;
  /** Why it was skipped, when ok is false (for /sandbox-llm status display). */
  reason?: "not_enabled" | "not_granted" | "no_active_key" | "unreachable";
  provider?: string;
  modelCount?: number;
}

/**
 * Ensure the LLM provider is registered with pi. Idempotent: reuses a cached
 * virtual key when present, reveals a fresh one only when needed. Writes the
 * resolved key/endpoint back to config so subsequent starts skip the network
 * round-trip.
 */
export async function ensureLlmProvider(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  client: PlatformClient,
): Promise<LlmSetupResult> {
  const config = client.config;
  const name = providerName(config);

  // 0. Direct gateway mode: a llmGateway block in the extension config
  //    (~/.pi/agent/extensions/sandbox-platform.json) bypasses the platform's
  //    LLM brokerage entirely — self-managed agentgateway deployments and local
  //    testing. The model list is fetched from the gateway itself when not
  //    pinned in config; session attribution rides the compat headers.
  if (config.llmGateway) {
    const gateway = config.llmGateway;
    let models = (gateway.models ?? []).map((id) => ({ id }));
    if (models.length === 0) {
      try {
        const res = await fetch(`${normalizeBaseUrl(gateway.endpoint)}/models`, {
          headers: { Authorization: `Bearer ${gateway.apiKey}` },
        });
        if (res.ok) {
          const data = await res.json() as { data?: Array<{ id: string }> };
          models = data.data?.map((m) => ({ id: m.id })) ?? [];
        }
      } catch {
        // register with an empty list; /sandbox-llm refresh can retry
      }
    }
    pi.registerProvider(name, {
      name,
      baseUrl: normalizeBaseUrl(gateway.endpoint),
      apiKey: gateway.apiKey,
      api: "openai-completions",
      authHeader: true,
      models: toProviderModels(models),
    });
    if (models.length === 0) {
      ctx.ui.notify(
        `LLM provider "${name}" registered in direct-gateway mode, but the model list is empty (gateway unreachable or no models). Re-run /sandbox-llm once it's back.`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        `LLM ready (direct gateway): ${name} (${models.length} models). Use /model to select.`,
        "info",
      );
    }
    return { ok: true, provider: name, modelCount: models.length };
  }

  // 1. Is LLM enabled for me at all? R4: a platform without the gateway answers
  //    501 LLM_NOT_ENABLED (legacy: 503). Both mean "feature absent" — skip
  //    silently, no notification, no blocking of session start.
  let status: Awaited<ReturnType<PlatformClient["getMyLlmStatus"]>>;
  try {
    status = await client.getMyLlmStatus();
  } catch (err) {
    if (err instanceof PlatformError && (err.status === 501 || err.status === 503)) {
      // LLM integration disabled on the platform — not an error, just nothing to do.
      return { ok: false, reason: "not_enabled" };
    }
    ctx.ui.notify(
      `LLM status check failed: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return { ok: false, reason: "unreachable" };
  }

  if (!status.binding || status.binding.revoked_at) {
    // No access granted (or revoked). Silent skip — the container flow continues.
    return { ok: false, reason: "not_granted" };
  }

  // 2. Resolve a usable virtual key. Prefer the cached one, but verify it is
  //    still active server-side (an admin may have revoked it since we cached).
  //    If the cache is empty or stale, reveal an active key.
  let virtualKey = config.llmVirtualKey;
  let keyId = config.llmKeyId;

  // Fetch the key list once: we need it both to validate the cached key and to
  // pick a fresh one if needed. A failure here is non-fatal — we fall back to
  // trusting the cache, and a revoked key will surface as a 401 on the first
  // LLM request (the user can then /sandbox-llm → force-refresh).
  let keys: Awaited<ReturnType<PlatformClient["listMyLlmKeys"]>> = [];
  try {
    keys = await client.listMyLlmKeys();
  } catch {
    // Leave keys empty; logic below degrades to trusting the cache.
  }

  const cachedStillActive =
    virtualKey && keyId !== undefined
      ? keys.some((k) => k.id === keyId && !k.revoked_at)
      : false;

  // If the list fetch failed (keys empty) but we have a cached key, trust it
  // for now — better than blocking the agent on a transient platform hiccup.
  const trustCache = keys.length === 0 && !!virtualKey;

  if (!virtualKey || (!cachedStillActive && !trustCache)) {
    const active = keys.find((k) => !k.revoked_at);
    if (!active) {
      // Granted but no key issued yet — admin must issue one, or the platform
      // auto-issued one that the user can't see. Surface gently.
      ctx.ui.notify(
        "LLM access granted but no active key. Ask an admin to issue one, or create it from the web UI.",
        "warning",
      );
      return { ok: false, reason: "no_active_key" };
    }
    try {
      const revealed = await client.revealMyLlmKey(active.id);
      virtualKey = revealed.plaintext;
      keyId = revealed.id;
      saveConfig({ llmVirtualKey: virtualKey, llmKeyId: keyId });
    } catch (err) {
      ctx.ui.notify(
        `Could not reveal LLM key: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return { ok: false, reason: "unreachable" };
    }
  } else if (virtualKey && keyId !== undefined && !cachedStillActive && trustCache) {
    // We're trusting a possibly-stale cache because the key list was
    // unreachable. Note it so a 401 later isn't surprising.
    ctx.ui.notify(
      "Could not verify LLM key status (platform unreachable); using cached key. Run /sandbox-llm if LLM calls fail.",
      "warning",
    );
  }

  // 3. Endpoint + model catalogue.
  let baseUrl = config.llmEndpoint;
  if (!baseUrl) {
    try {
      const ep = await client.getLlmEndpoint();
      baseUrl = ep.baseUrl;
      saveConfig({ llmEndpoint: baseUrl });
    } catch (err) {
      ctx.ui.notify(
        `Could not fetch LLM endpoint: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return { ok: false, reason: "unreachable" };
    }
  }

  let models: Array<{ id: string }> = [];
  let modelsUnreachable = false;
  try {
    models = await client.listLlmModels();
  } catch {
    // Models are best-effort; register with an empty list rather than failing.
    models = [];
    modelsUnreachable = true;
  }

  // 4. Register the provider with pi. Safe to call repeatedly.
  const providerConfig: ProviderConfig = {
    name,
    baseUrl: normalizeBaseUrl(baseUrl!),
    apiKey: virtualKey!,
    api: "openai-completions",
    authHeader: true,
    models: toProviderModels(models),
  };
  pi.registerProvider(name, providerConfig);

  if (modelsUnreachable || models.length === 0) {
    ctx.ui.notify(
      `LLM provider "${name}" registered, but the model list is empty (gateway may be unreachable). Re-run /sandbox-llm once it's back.`,
      "warning",
    );
  } else {
    ctx.ui.notify(
      `LLM ready: ${name} (${models.length} models). Use /model to select.`,
      "info",
    );
  }
  return { ok: true, provider: name, modelCount: models.length };
}

/**
 * Force-refresh the LLM provider: clear the cached key and re-run setup. Used by
 * the /sandbox-llm command after a key is rotated or access is newly granted.
 */
export async function refreshLlmProvider(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  client: PlatformClient,
): Promise<LlmSetupResult> {
  saveConfig({ llmVirtualKey: undefined, llmKeyId: undefined, llmEndpoint: undefined });
  client.config.llmVirtualKey = undefined;
  client.config.llmKeyId = undefined;
  client.config.llmEndpoint = undefined;
  return ensureLlmProvider(pi, ctx, client);
}
