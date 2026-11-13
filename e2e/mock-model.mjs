/**
 * 脚本化 OpenAI 兼容模型（E2E 专用）。
 *
 * 目的：让真实 Agent 循环**确定性地**发起一次工具调用（默认 `write`），
 * 从而触发路径护栏的 ask 对话框——无需真实模型凭据/网络，也不受模型
 * 服从性影响。
 *
 * 协议：POST /v1/chat/completions（支持 stream=true 的 SSE 与一次性 JSON）。
 * 行为：
 *   · 最后一条消息是 user（新回合）→ 返回一次工具调用；
 *   · 最后一条消息是 tool（工具结果已回填）→ 返回文本 "mock-done-<回合号>"。
 * 工具目标路径由测试通过 queueTarget() 预先排队（每个工具调用消费一个）。
 */
import { createServer } from "node:http";

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function completionChunk(model, delta, finishReason = null) {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendJson(res, body, text) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "e2e-script",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }),
  );
}

function sendSseText(res, body, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const model = body.model ?? "e2e-script";
  res.write(chunk(completionChunk(model, { role: "assistant", content: "" })));
  res.write(chunk(completionChunk(model, { content: text })));
  res.write(chunk(completionChunk(model, {}, "stop")));
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendSseToolCall(res, body, callId, args) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const model = body.model ?? "e2e-script";
  res.write(chunk(completionChunk(model, { role: "assistant", content: "" })));
  res.write(
    chunk(
      completionChunk(model, {
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: { name: "write", arguments: JSON.stringify(args) },
          },
        ],
      }),
    ),
  );
  res.write(chunk(completionChunk(model, {}, "tool_calls")));
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * @returns {Promise<{baseUrl: string, queueTarget: (path: string) => void, calls: Array<object>, close: () => Promise<void>}>}
 */
export async function startMockModel() {
  const targets = [];
  const calls = [];
  let callSeq = 0;

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "e2e-script", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // fall through with empty body
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastRole = messages.at(-1)?.role;
      const userTurns = messages.filter((m) => m.role === "user").length;
      const stream = body.stream !== false;
      calls.push({ lastRole, userTurns, stream });
      if (lastRole === "tool") {
        const text = `mock-done-${userTurns}`;
        if (stream) sendSseText(res, body, text);
        else sendJson(res, body, text);
        return;
      }
      const target = targets.shift() ?? "/tmp/e2e-missing-target.txt";
      const args = { path: target, content: `e2e-${callSeq}` };
      if (stream) sendSseToolCall(res, body, `call_${callSeq++}`, args);
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? "e2e-script",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: `call_${callSeq++}`, type: "function", function: { name: "write", arguments: JSON.stringify(args) } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    queueTarget: (path) => targets.push(path),
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
