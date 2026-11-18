import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { clientIpOf } = await jiti.import("./rate-limit.ts");

test("WHATWG Headers (route handlers) expose x-forwarded-for", () => {
  const req = new Request("http://localhost/", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } });
  // Regression: bracket access on a Headers object used to return undefined,
  // bucketing every login under "unknown" (10/min for the whole server).
  assert.equal(clientIpOf(req), "1.2.3.4");
});

test("x-real-ip is the fallback when x-forwarded-for is absent", () => {
  const req = new Request("http://localhost/", { headers: { "x-real-ip": "5.6.7.8" } });
  assert.equal(clientIpOf(req), "5.6.7.8");
});

test("Node-style header bags (relay WebSocket) still work", () => {
  assert.equal(clientIpOf({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.2" } }), "9.9.9.9");
  assert.equal(clientIpOf({ headers: { "x-forwarded-for": ["8.8.8.8", "10.0.0.3"] } }), "8.8.8.8");
  assert.equal(clientIpOf({ headers: { "x-real-ip": "7.7.7.7" } }), "7.7.7.7");
});

test("socket address and the unknown fallback remain", () => {
  assert.equal(clientIpOf({ headers: {}, socket: { remoteAddress: "192.0.2.10" } }), "192.0.2.10");
  assert.equal(clientIpOf({ headers: {} }), "unknown");
});

test("two different clients no longer share the unknown bucket", () => {
  const first = clientIpOf(new Request("http://localhost/", { headers: { "x-forwarded-for": "198.51.100.1" } }));
  const second = clientIpOf(new Request("http://localhost/", { headers: { "x-forwarded-for": "198.51.100.2" } }));
  assert.notEqual(first, second);
});
