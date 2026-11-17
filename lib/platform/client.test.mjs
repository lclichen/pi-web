import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_PLATFORM_URL = "http://127.0.0.1:3000";
delete process.env.PI_WEB_PLATFORM_PUBLIC_URL;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { platformBrowserUrl } = await jiti.import("./client.ts");

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
