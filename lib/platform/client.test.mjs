import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_PLATFORM_URL = "http://127.0.0.1:3000";
delete process.env.PI_WEB_PLATFORM_PUBLIC_URL;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { platformAnonGet, platformAnonPost, platformBrowserUrl, platformGet, platformPostBearer } =
  await jiti.import("./client.ts");

test("a loopback platform address is rewritten to the browser's pi-web host", () => {
  assert.equal(platformBrowserUrl("http://10.99.9.7:30141"), "http://10.99.9.7:3000");
});

test("a non-loopback platform address is kept as-is", () => {
  process.env.PI_WEB_PLATFORM_URL = "http://platform.internal:3000";
  try {
    assert.equal(platformBrowserUrl("http://10.0.0.5:30141"), "http://platform.internal:3000");
  } finally {
    process.env.PI_WEB_PLATFORM_URL = "http://127.0.0.1:3000";
  }
});

test("PI_WEB_PLATFORM_PUBLIC_URL wins over the loopback rewrite", () => {
  process.env.PI_WEB_PLATFORM_PUBLIC_URL = "https://platform.example.com/";
  try {
    assert.equal(platformBrowserUrl("http://10.99.9.7:30141"), "https://platform.example.com");
  } finally {
    delete process.env.PI_WEB_PLATFORM_PUBLIC_URL;
  }
});

test("a loopback browser host cannot improve the platform address", () => {
  assert.equal(platformBrowserUrl("http://127.0.0.1:30141"), "http://127.0.0.1:3000");
});

test("non-JSON error body (e.g. a proxy 502 HTML page) falls back to `platform HTTP <status>`", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>502</html>", { status: 502 });
  try {
    const expectFallback = (err) =>
      err instanceof Error && !(err instanceof SyntaxError) && err.message === "platform HTTP 502" && err.status === 502;
    await assert.rejects(platformGet("/api/v1/things", "key"), expectFallback);
    await assert.rejects(platformPostBearer("/api/v1/things", "jwt", {}), expectFallback);
    const anonPost = await platformAnonPost("/api/v1/auth/login", {});
    assert.equal(anonPost.ok, false);
    assert.equal(anonPost.error.message, "platform HTTP 502");
    const anon = await platformAnonGet("/api/v1/config");
    assert.equal(anon.ok, false);
    assert.equal(anon.error.message, "platform HTTP 502");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a non-JSON success body still resolves as null instead of throwing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>ok</html>", { status: 200 });
  try {
    assert.equal(await platformGet("/api/v1/things", "key"), null);
    const anon = await platformAnonGet("/api/v1/config");
    assert.equal(anon.ok, true);
    assert.equal(anon.data, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
