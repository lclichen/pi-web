import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_AUTH = "on";
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "oidc-begin-"));
process.env.PI_WEB_PLATFORM_URL = "http://127.0.0.1:3000";
delete process.env.PI_WEB_PUBLIC_URL;
delete process.env.PI_WEB_PLATFORM_PUBLIC_URL;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");

test("begin redirects the browser to a reachable platform and a browser-visible callback", async () => {
  const response = await GET(
    new Request("http://0.0.0.0:30141/api/webauth/oidc/begin", {
      headers: { host: "10.99.9.7:30141" },
    }),
  );
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "http://10.99.9.7:3000");
  assert.equal(location.pathname, "/api/v1/auth/oidc/begin");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "http://10.99.9.7:30141/api/webauth/oidc/callback",
  );
});

test("forwarded host/proto describe the browser origin behind a reverse proxy", async () => {
  const response = await GET(
    new Request("http://127.0.0.1:30141/api/webauth/oidc/begin", {
      headers: {
        host: "127.0.0.1:30141",
        "x-forwarded-host": "pi.example.com",
        "x-forwarded-proto": "https",
      },
    }),
  );
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "http://pi.example.com:3000");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://pi.example.com/api/webauth/oidc/callback",
  );
});
