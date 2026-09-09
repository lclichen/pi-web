import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, GET } = await jiti.import("./route.ts");

const FEEDBACK_URL = "http://127.0.0.1:4001/api/feedback";
const EXPORT_URL = "http://127.0.0.1:4001/api/feedback/export";

// Pin the identity model these tests assert against (auth off → implicit
// host admin) and restore whatever the environment had afterwards.
const SAVED_GATEWAY = process.env.AGENTGATEWAY_URL;
const SAVED_AUTH = process.env.PI_WEB_AUTH;
process.env.PI_WEB_AUTH = "off";
delete process.env.AGENTGATEWAY_URL;
after(() => {
  if (SAVED_GATEWAY === undefined) delete process.env.AGENTGATEWAY_URL;
  else process.env.AGENTGATEWAY_URL = SAVED_GATEWAY;
  if (SAVED_AUTH === undefined) delete process.env.PI_WEB_AUTH;
  else process.env.PI_WEB_AUTH = SAVED_AUTH;
});

function postRequest(body, headers = {}) {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    // Constructed Requests carry no Host header; the API-security check needs one.
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Swap globalThis.fetch for the duration of one test; captures what the
 * proxy actually sent so tests can assert on the re-stamped identity. */
function stubFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return handler(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("POST without AGENTGATEWAY_URL answers 503 with empty accepted (outbox keeps)", async (t) => {
  delete process.env.AGENTGATEWAY_URL;
  const calls = stubFetch(t, () => { throw new Error("must not be called"); });
  const res = await POST(postRequest({ feedback: [{ sessionId: "s1", entryId: "e1", value: "up" }] }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { accepted: [] });
  assert.equal(calls.length, 0);
});

test("POST re-stamps the session user and passes the batch through", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001/";
  const calls = stubFetch(t, () => new Response(JSON.stringify({ accepted: ["s1:e1"] }), { status: 200 }));
  const res = await POST(postRequest({
    user: "attacker", // spoofed client identity must be dropped
    feedback: [{ sessionId: "s1", entryId: "e1", value: "up", snippet: "hi", createdAt: 1_700_000_000_000 }],
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: ["s1:e1"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, FEEDBACK_URL);
  const sent = JSON.parse(calls[0].init.body);
  // Auth off → implicit host admin; username (not the spoofed field) is sent.
  assert.equal(sent.user, "host");
  assert.equal(sent.feedback.length, 1);
  assert.equal(sent.feedback[0].sessionId, "s1");
});

test("POST passes non-2xx gateway answers through unchanged", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  stubFetch(t, () => new Response(JSON.stringify({ error: "feedback batch of 51 exceeds the maximum of 50" }), { status: 400 }));
  const res = await POST(postRequest({ feedback: [{ sessionId: "s", entryId: "e", value: "down" }] }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /maximum/);
});

test("POST maps gateway 5xx to the outbox contract instead of leaking the body", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  stubFetch(t, () => new Response("internal panic: /var/lib/gateway", { status: 500 }));
  const res = await POST(postRequest({ feedback: [{ sessionId: "s", entryId: "e", value: "up" }] }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { accepted: [] });
});

test("POST rejects non-JSON content types before touching the gateway", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  const calls = stubFetch(t, () => new Response("{}", { status: 200 }));
  const res = await POST(new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { host: "localhost", "content-type": "text/plain" },
    body: "feedback=[]",
  }));
  assert.equal(res.status, 415);
  assert.equal(calls.length, 0);
});

test("POST turns transport failures into 502 with empty accepted", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  stubFetch(t, () => { throw new Error("connection refused"); });
  const res = await POST(postRequest({ feedback: [{ sessionId: "s", entryId: "e", value: "up" }] }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { accepted: [] });
});

test("POST rejects malformed bodies before contacting the gateway", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  const calls = stubFetch(t, () => new Response("{}", { status: 200 }));

  for (const body of [{}, { feedback: "nope" }, { feedback: [] }, "{broken"]) {
    const res = await POST(postRequest(body));
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  const oversized = { feedback: Array.from({ length: 51 }, (_, i) => ({ sessionId: "s", entryId: `e${i}`, value: "up" })) };
  const res = await POST(postRequest(oversized));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /maximum/);
  assert.equal(calls.length, 0);
});

test("GET export streams the gateway JSONL through", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  const calls = stubFetch(t, () => new Response('{"sessionId":"s1"}\n', {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  }));
  const res = await GET(new Request("http://localhost/api/feedback", { headers: { host: "localhost" } }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  assert.equal(await res.text(), '{"sessionId":"s1"}\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, EXPORT_URL);
});

test("GET export without AGENTGATEWAY_URL answers 503", async () => {
  delete process.env.AGENTGATEWAY_URL;
  const res = await GET(new Request("http://localhost/api/feedback", { headers: { host: "localhost" } }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /AGENTGATEWAY_URL/);
});

test("GET export turns transport failures into 502", async (t) => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  stubFetch(t, () => { throw new Error("connection refused"); });
  const res = await GET(new Request("http://localhost/api/feedback", { headers: { host: "localhost" } }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /无法连接/);
});

test("GET rejects untrusted hosts (DNS-rebinding guard)", async () => {
  process.env.AGENTGATEWAY_URL = "http://127.0.0.1:4001";
  const res = await GET(new Request("http://evil.example.com/api/feedback", { headers: { host: "evil.example.com" } }));
  assert.equal(res.status, 403);
});
