import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("gateway metadata fills in when present and stays absent otherwise", () => {
  // snake_case（/v1/models 响应形态，见 docs/dev/models-api-sample.json）
  assert.deepEqual(parseDiscoveredModels({ data: [{
    id: "MS/*",
    context_length: 131072,
    max_output_tokens: 16384,
    input_modalities: ["text"],
    output_modalities: ["text"],
  }] }), [
    { id: "MS/*", contextLength: 131072, maxOutputTokens: 16384, inputModalities: ["text"] },
  ]);
  // camelCase 配置形态
  assert.deepEqual(parseDiscoveredModels({ models: [{
    id: "vision", contextLength: 65536, maxOutputTokens: 8192, inputModalities: ["text", "image"],
  }] }), [
    { id: "vision", contextLength: 65536, maxOutputTokens: 8192, inputModalities: ["text", "image"] },
  ]);
  // 无 metadata 的模型不受影响；非法值（0/负数/非数组）按缺失处理
  assert.deepEqual(parseDiscoveredModels({ data: [
    { id: "plain" },
    { id: "bad", context_length: 0, max_output_tokens: -1, input_modalities: "text" },
  ] }), [
    { id: "bad" },
    { id: "plain" },
  ]);
});

test("resolves environment-backed headers without an API key", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});
