import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

/**
 * amedac-core OTLP tracing: config resolution + a real OTLP/HTTP JSON POST.
 * Drives the extension through its public pi event handlers with a fake pi/ctx.
 */

const dataDir = mkdtempSync(join(tmpdir(), "otel-tracing-"));
const settingsFile = join(dataDir, "state", "global", "server-settings.json");
function writeSettings(data) {
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 1, data }));
}
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_OTEL_ENABLED;
delete process.env.PI_OTEL_DISABLED;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

const { resolveOTelTracingConfig, otelTracesUrl, makeOtelTracingExtension, flushOtelTracing } = await import(
  "./otel-tracing.ts"
);

test.after(() => {
  delete process.env.PI_WEB_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

test("config: disabled by default, enabled from pi-web settings", () => {
  assert.equal(resolveOTelTracingConfig(), null);

  writeSettings({
    otelEnabled: true,
    otelEndpoint: "http://127.0.0.1:9999",
    otelHeaders: { "x-mlflow-experiment-id": "42" },
  });
  const config = resolveOTelTracingConfig();
  assert.equal(config?.endpoint, "http://127.0.0.1:9999");
  assert.equal(config?.headers["x-mlflow-experiment-id"], "42");
  assert.equal(otelTracesUrl(config.endpoint), "http://127.0.0.1:9999/v1/traces");
  assert.equal(
    otelTracesUrl("http://127.0.0.1:9999/v1/traces"),
    "http://127.0.0.1:9999/v1/traces",
  );

  writeSettings({ otelEnabled: false });
  assert.equal(resolveOTelTracingConfig(), null);
});

test("extension emits a GenAI span tree over OTLP/HTTP JSON", async (t) => {
  const requests = [];
  const waitForRequests = async (count) => {
    const deadline = Date.now() + 3000;
    while (requests.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${count} OTLP requests, got ${requests.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeSettings({
    otelEnabled: true,
    otelEndpoint: `http://127.0.0.1:${port}`,
    otelHeaders: { "x-mlflow-experiment-id": "exp-1" },
  });

  const sessionId = "sess-otel-test";
  const identityKey = Symbol.for("@agegr/pi-web/session-identity/v1");
  globalThis[identityKey] = {
    get: (id) => (id === sessionId ? { userId: 7, userName: "alice" } : undefined),
  };

  const handlers = new Map();
  const pi = {
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  makeOtelTracingExtension()(pi);

  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getHeader: () => ({ type: "session", id: sessionId, timestamp: "", cwd: "/" }),
    },
  };
  const emit = async (name, event) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };

  await emit("session_start", { type: "session_start", reason: "new" });
  await emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "hello agent",
    systemPrompt: "",
  });
  await emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  await emit("message_start", {
    type: "message_start",
    message: { role: "assistant", model: "qwen3", provider: "amedac" },
  });
  await emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      model: "qwen3",
      responseModel: "qwen3",
      provider: "amedac",
      content: [
        { type: "text", text: "done" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 3 },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  await emit("tool_execution_start", {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls" },
  });
  await emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: "file.txt",
    isError: false,
  });
  await emit("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });
  await emit("agent_settled", { type: "agent_settled" });
  await flushOtelTracing();
  await waitForRequests(1);
  const spans = requests[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(requests[0].url, "/v1/traces");
  assert.equal(requests[0].headers["x-mlflow-experiment-id"], "exp-1");
  assert.equal(requests[0].headers["accept-encoding"], "identity");
  assert.ok(spans.some((span) => span.name === "invoke_agent amedac-pi-web"));
  assert.ok(spans.some((span) => span.name === "chat qwen3"));
  assert.ok(spans.some((span) => span.name === "execute_tool bash"));

  const attrs = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
  const root = attrs(spans.find((span) => span.name.startsWith("invoke_agent")));
  assert.equal(root["gen_ai.conversation.id"].stringValue, sessionId);
  assert.equal(root["session.id"].stringValue, sessionId);
  assert.equal(root["user.id"].intValue, "7");
  assert.equal(root["user.name"].stringValue, "alice");
  assert.match(root["gen_ai.input.messages"].stringValue, /hello agent/);
  assert.match(root["gen_ai.output.messages"].stringValue, /done/);

  const chat = attrs(spans.find((span) => span.name === "chat qwen3"));
  assert.equal(chat["gen_ai.operation.name"].stringValue, "chat");
  assert.equal(chat["gen_ai.usage.input_tokens"].intValue, "13");
  assert.equal(chat["gen_ai.usage.cache_creation.input_tokens"].intValue, "3");
  assert.match(chat["gen_ai.output.messages"].stringValue, /done/);

  const tool = attrs(spans.find((span) => span.name === "execute_tool bash"));
  assert.equal(tool["gen_ai.tool.name"].stringValue, "bash");
  assert.match(tool["gen_ai.tool.call.arguments"].stringValue, /ls/);
  assert.equal(tool["gen_ai.tool.call.result"].stringValue, "file.txt");

  // A second independent prompt in the same session must be a separate trace
  // (one trace per user message) that still carries the same session id.
  const firstTraceId = spans[0].traceId;
  await emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "second question",
    systemPrompt: "",
  });
  await emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
  await emit("message_start", {
    type: "message_start",
    message: { role: "assistant", model: "qwen3", provider: "amedac" },
  });
  await emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      model: "qwen3",
      responseModel: "qwen3",
      provider: "amedac",
      content: [{ type: "text", text: "second answer" }],
      usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  await emit("turn_end", { type: "turn_end", turnIndex: 1, message: {}, toolResults: [] });
  await emit("agent_settled", { type: "agent_settled" });
  await flushOtelTracing();
  await waitForRequests(2);

  const secondSpans = requests[1].body.resourceSpans[0].scopeSpans[0].spans;
  const secondRootSpan = secondSpans.find((span) => span.name.startsWith("invoke_agent"));
  const secondRoot = attrs(secondRootSpan);
  assert.notEqual(secondRootSpan.traceId, firstTraceId);
  assert.equal(secondRoot["session.id"].stringValue, sessionId);
  assert.equal(secondRoot["gen_ai.conversation.id"].stringValue, sessionId);
  assert.match(secondRoot["gen_ai.input.messages"].stringValue, /second question/);
  assert.match(secondRoot["gen_ai.output.messages"].stringValue, /second answer/);
  const secondChat = attrs(secondSpans.find((span) => span.name === "chat qwen3"));
  assert.match(secondChat["gen_ai.input.messages"].stringValue, /second question/);
  assert.match(secondChat["gen_ai.output.messages"].stringValue, /second answer/);

  delete globalThis[identityKey];
});
