import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Time-window checks for the mock model server's fair-share scheduler:
 *   rate = min(cap, active <= 6 ? cap : floor(budget / active))
 * Calibration points from the real provider: 6 streams -> 80 tok/s each,
 * 20 streams -> 15 tok/s each (budget 300 / cap 80).
 */

function startServer(t, { port, budget, cap }) {
  const child = spawn(
    process.execPath,
    ["mock-model-server.mjs", "--port", String(port), "--budget", String(budget), "--cap", String(cap)],
    { cwd: new URL(".", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => {
    child.kill();
  });
  return { child, readOutput: () => output };
}

async function waitForServer(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stats`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("mock server did not start");
}

async function openStream(port, tokens) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mock-load-default",
      stream: true,
      messages: [{ role: "user", content: `MOCKLEN:${tokens}` }],
    }),
  });
  assert.equal(res.status, 200);
  return res.body.getReader();
}

async function readTokens(reader, count) {
  const decoder = new TextDecoder();
  let buffer = "";
  let tokens = 0;
  while (tokens < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (!frame.startsWith("data: ")) continue;
      const payload = frame.slice(6);
      if (payload === "[DONE]") continue;
      const event = JSON.parse(payload);
      if (event.choices?.[0]?.delta?.content) tokens += 1;
    }
  }
  await reader.cancel().catch(() => {});
  return tokens;
}

test("fair share holds the cap while few streams are active", async (t) => {
  const port = 3191;
  const { readOutput } = startServer(t, { port, budget: 300, cap: 80 });
  await waitForServer(port);

  // One stream: capped at 80 tok/s → 40 tokens ≈ 500 ms (allow scheduling slack).
  const started = performance.now();
  const reader = await openStream(port, 40);
  const tokens = await readTokens(reader, 40);
  const elapsed = performance.now() - started;
  assert.equal(tokens, 40);
  assert.ok(elapsed >= 400 && elapsed <= 1500, `40 tokens at ~80/s expected ~500ms, got ${elapsed.toFixed(0)}ms`);
  void readOutput;
});

test("fair share divides the budget once more than 6 streams are active", async (t) => {
  const port = 3192;
  startServer(t, { port, budget: 300, cap: 80 });
  await waitForServer(port);

  // 7 concurrent streams: rate = floor(300/7) = 42 tok/s each.
  const readers = [];
  for (let i = 0; i < 7; i += 1) {
    readers.push(await openStream(port, 400));
  }
  // Wait until the server reports all 7 active, then check the scheduler math.
  let rate = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
    if (stats.activeStreams === 7) {
      rate = stats.currentRatePerStream;
      break;
    }
    await sleep(100);
  }
  assert.equal(rate, 42, "floor(300/7) per stream once active > 6");

  for (const reader of readers) await reader.cancel().catch(() => {});
});

test("stats expose the scheduler state and models endpoint lists ids", async (t) => {
  const port = 3193;
  startServer(t, { port, budget: 240, cap: 60 });
  await waitForServer(port);

  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  assert.deepEqual(
    models.data.map((m) => m.id),
    ["mock-load-default", "mock-load-small"],
  );

  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  assert.equal(stats.budgetTokensPerSecond, 240);
  assert.equal(stats.capTokensPerSecond, 60);
  assert.equal(stats.activeStreams, 0);
});

test("MOCKTOOL answers with a streamed bash tool call", async (t) => {
  const port = 3194;
  startServer(t, { port, budget: 300, cap: 80 });
  await waitForServer(port);

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mock-load-default",
      stream: true,
      messages: [{ role: "user", content: "MOCKTOOL" }],
    }),
  });
  const text = await res.text();
  const finish = /"finish_reason":"tool_calls"/.test(text);
  const toolCall = /"tool_calls"/.test(text) && /"name":"bash"/.test(text);
  assert.ok(finish, "stream ends with finish_reason tool_calls");
  assert.ok(toolCall, "stream carries a bash tool call");
  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  assert.ok(stats.totalToolCalls >= 1);
});
