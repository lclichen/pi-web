#!/usr/bin/env node
/**
 * Mock OpenAI-compatible model server for pi-web load tests (dev 批次5).
 * Zero dependencies: node perf/mock-model-server.mjs [--port 3099] [--budget 300] [--cap 80]
 *
 * Endpoints:
 *   GET  /v1/models            — model catalogue
 *   POST /v1/chat/completions  — streaming SSE (default) or plain JSON
 *   GET  /stats                — live scheduler counters
 *
 * Token scheduling = global-budget fair share (agreed semantics):
 *   rate_per_stream = min(cap, active <= 6 ? cap : floor(budget / active))
 * With the defaults (budget 300 tok/s, cap 80): 6 streams → 80 tok/s each,
 * 20 streams → 15 tok/s each, 100 streams → 3 tok/s each — matching the two
 * calibration points the real provider exhibits.
 *
 * Behavior is steered from the LAST user message text:
 *   MOCKLEN:<n>  — reply with ~n tokens (default 300)
 *   MOCKTOOL     — answer with a bash `echo` tool call first; the SDK executes
 *                  it for real, and the follow-up request (which then carries
 *                  the tool result) gets the final text. This exercises the
 *                  "a user's tool call must not block anyone" requirement.
 */
import http from "node:http";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.MOCK_PORT ?? "3099" },
    host: { type: "string", default: process.env.MOCK_HOST ?? "127.0.0.1" },
    budget: { type: "string", default: process.env.MOCK_BUDGET ?? "300" },
    cap: { type: "string", default: process.env.MOCK_CAP ?? "80" },
  },
});

const PORT = Number(args.port);
const BUDGET = Number(args.budget); // global tokens/s shared across streams
const CAP = Number(args.cap); // per-stream ceiling
if (!Number.isFinite(PORT) || !Number.isFinite(BUDGET) || !Number.isFinite(CAP) || BUDGET <= 0 || CAP <= 0) {
  console.error("invalid --port/--budget/--cap");
  process.exit(1);
}

const MODEL_IDS = ["mock-load-default", "mock-load-small"];

const stats = {
  startedAt: Date.now(),
  activeStreams: 0,
  totalRequests: 0,
  totalToolCalls: 0,
  totalTokens: 0,
  errors: 0,
};

/** Fair-share per-stream rate for the current active count. */
function currentRate() {
  const active = Math.max(1, stats.activeStreams);
  return Math.max(1, Math.min(CAP, active <= 6 ? CAP : Math.floor(BUDGET / active)));
}

function lastUserMessage(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === "user") return m;
  }
  return null;
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join(" ");
  }
  return "";
}

function hasToolResult(messages) {
  return (messages ?? []).some((m) => m && (m.role === "tool" || m.role === "toolResult"));
}

function planResponse(messages) {
  const last = messageText(lastUserMessage(messages));
  const lengthMatch = /MOCKLEN:(\d+)/.exec(last);
  const tokens = lengthMatch ? Math.max(1, Math.min(20000, Number(lengthMatch[1]))) : 300;
  const wantsTool = last.includes("MOCKTOOL") && !hasToolResult(messages);
  return { tokens, wantsTool, marker: last.includes("MOCKMARK") ? last.match(/MOCKMARK:(\S+)/)?.[1] : undefined };
}

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
function tokenAt(index, marker) {
  if (marker && index === 0) return `${marker}`;
  return `${WORDS[index % WORDS.length]}${index % 7 === 0 ? `-${index}` : ""}`;
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendError(res, status, message) {
  stats.errors += 1;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "mock_error" } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function completionId() {
  return `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`;
}

async function handleChatCompletions(req, res) {
  stats.totalRequests += 1;
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    sendError(res, 400, `invalid JSON body: ${error.message}`);
    return;
  }
  const messages = body.messages ?? [];
  const stream = body.stream !== false;
  const model = body.model ?? MODEL_IDS[0];
  const { tokens, wantsTool, marker } = planResponse(messages);

  stats.activeStreams += 1;
  const startedAt = Date.now();
  try {
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const id = completionId();
      const created = Math.floor(startedAt / 1000);
      const base = { id, object: "chat.completion.chunk", created, model };
      sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });

      if (wantsTool) {
        stats.totalToolCalls += 1;
        // One streamed tool call: bash echo. The agent loop executes it for
        // real and comes back with the tool result for the final answer.
        const fn = { name: "bash", arguments: JSON.stringify({ command: `echo mock-load-${id}` }) };
        sseChunk(res, {
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call-${id}`, type: "function", function: { name: fn.name, arguments: "" } }] },
              finish_reason: null,
            },
          ],
        });
        for (const piece of [fn.arguments.slice(0, 10), fn.arguments.slice(10)]) {
          if (!piece) continue;
          await pace();
          sseChunk(res, {
            ...base,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }],
          });
        }
        await pace();
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        for (let i = 0; i < tokens; i += 1) {
          await pace();
          sseChunk(res, {
            ...base,
            choices: [{ index: 0, delta: { content: `${tokenAt(i, marker)} ` }, finish_reason: null }],
          });
          stats.totalTokens += 1;
          tokenTimes.push(Date.now());
        }
        await pace();
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      sseChunk(res, "[DONE]");
      res.end();
    } else {
      let content = "";
      if (wantsTool) {
        stats.totalToolCalls += 1;
        content = "";
      } else {
        for (let i = 0; i < tokens; i += 1) {
          await pace();
          content += `${tokenAt(i, marker)} `;
          stats.totalTokens += 1;
          tokenTimes.push(Date.now());
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: completionId(),
          object: "chat.completion",
          created: Math.floor(startedAt / 1000),
          model,
          choices: [
            wantsTool
              ? {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: `call-${completionId()}`,
                        type: "function",
                        function: { name: "bash", arguments: JSON.stringify({ command: `echo mock-load` }) },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                }
              : { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: tokens + 10 },
        }),
      );
    }
  } catch (error) {
    if (!res.headersSent) sendError(res, 500, error.message);
    else res.end();
  } finally {
    stats.activeStreams -= 1;
  }
}

/** Wait one token interval at the CURRENT fair-share rate. */
function pace() {
  const rate = currentRate();
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(1000 / rate))));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODEL_IDS.map((id) => ({ id, object: "model", owned_by: "mock" })) }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ...stats,
        uptimeMs: Date.now() - stats.startedAt,
        budgetTokensPerSecond: BUDGET,
        capTokensPerSecond: CAP,
        currentRatePerStream: currentRate(),
        tokensPerSecondRecent: recentTokensPerSecond(),
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    void handleChatCompletions(req, res);
    return;
  }
  sendError(res, 404, `no route: ${req.method} ${url.pathname}`);
});

// Rolling tokens/s for /stats verification.
const tokenTimes = [];
function recentTokensPerSecond() {
  const cutoff = Date.now() - 5000;
  return tokenTimes.filter((t) => t >= cutoff).length / 5;
}

server.listen(PORT, args.host, () => {
  console.log(`[mock-model] listening on http://${args.host}:${PORT}/v1 (budget ${BUDGET} tok/s, cap ${CAP} tok/s per stream)`);
  console.log(`[mock-model] fair share: <=6 streams -> ${CAP} tok/s each; 20 -> ${Math.floor(BUDGET / 20)}; 100 -> ${Math.floor(BUDGET / 100)}`);
});
