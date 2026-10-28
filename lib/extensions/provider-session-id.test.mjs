import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Provider session-affinity metadata (merged into amedac-core): every
 * amedac-core session stamps x-session-id / session_id / x-session-affinity
 * headers on provider requests, plus the LiteLLM `litellm_session_id` body
 * field for LiteLLM-backed providers.
 */

async function loadExtension() {
  const mod = await jiti.import("../../pi-config/agent/extensions/amedac-core/src/provider-session-id.ts");
  const handlers = new Map();
  mod.makeProviderSessionIdExtension()({
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  });
  return handlers;
}

const ctx = { sessionManager: { getSessionId: () => "sess-42" }, model: { provider: "amedac.ai" } };

test("stamps the three affinity headers on every provider request", async () => {
  const handlers = await loadExtension();
  const [onHeaders] = handlers.get("before_provider_headers");
  const event = { type: "before_provider_headers", headers: { "X-Existing": "1" } };
  await onHeaders(event, ctx);
  assert.equal(event.headers["x-session-id"], "sess-42");
  assert.equal(event.headers["session_id"], "sess-42");
  assert.equal(event.headers["x-session-affinity"], "sess-42");
  assert.equal(event.headers["X-Existing"], "1", "existing headers are preserved");
});

test("adds litellm_session_id for LiteLLM-backed providers only", async () => {
  const handlers = await loadExtension();
  const [onRequest] = handlers.get("before_provider_request");

  for (const provider of ["amedac.ai", "litellm"]) {
    const out = await onRequest(
      { type: "before_provider_request", payload: { model: "m" } },
      { ...ctx, model: { provider } },
    );
    assert.equal(out.litellm_session_id, "sess-42", provider);
    assert.equal(out.model, "m", "payload fields are preserved");
  }

  const other = await onRequest(
    { type: "before_provider_request", payload: { model: "m" } },
    { ...ctx, model: { provider: "anthropic" } },
  );
  assert.equal("litellm_session_id" in other, false);
});

test("no session id (or missing context) is a no-op", async () => {
  const handlers = await loadExtension();
  const [onHeaders] = handlers.get("before_provider_headers");
  const event = { type: "before_provider_headers", headers: {} };
  await onHeaders(event, { sessionManager: { getSessionId: () => undefined }, model: undefined });
  assert.deepEqual(event.headers, {});
});
