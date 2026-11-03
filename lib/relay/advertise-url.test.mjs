import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { publicBaseOrigin, relayServerUrlFromPublicBase } = await jiti.import("./advertise-url.ts");

test("relay server URL uses the public host and the relay port", () => {
  assert.equal(relayServerUrlFromPublicBase("http://10.99.9.7:30141", 30142), "http://10.99.9.7:30142");
  assert.equal(relayServerUrlFromPublicBase("https://ide.example.com", 30142), "https://ide.example.com:30142");
  assert.equal(relayServerUrlFromPublicBase("http://10.99.9.7", 31000), "http://10.99.9.7:31000");
  // path/query are dropped: the relay has its own port (use PI_RELAY_ADVERTISE_URL
  // for a path-based reverse proxy).
  assert.equal(relayServerUrlFromPublicBase("https://ide.example.com/app", 30142), "https://ide.example.com:30142");
});

test("IPv6 hosts are bracketed once; invalid input falls back to null", () => {
  assert.equal(relayServerUrlFromPublicBase("http://[::1]:30141", 30142), "http://[::1]:30142");
  assert.equal(relayServerUrlFromPublicBase(null, 30142), null);
  assert.equal(relayServerUrlFromPublicBase("not a url", 30142), null);
  assert.equal(relayServerUrlFromPublicBase("ftp://host", 30142), null);
  assert.equal(relayServerUrlFromPublicBase("http://host", 0), null);
  assert.equal(relayServerUrlFromPublicBase("http://host", 70000), null);
});

test("public base origin keeps scheme/host/port and drops the path", () => {
  assert.equal(publicBaseOrigin("https://ide.example.com/app"), "https://ide.example.com");
  assert.equal(publicBaseOrigin("http://10.99.9.7:30141"), "http://10.99.9.7:30141");
  assert.equal(publicBaseOrigin(""), null);
  assert.equal(publicBaseOrigin("nope"), null);
});
