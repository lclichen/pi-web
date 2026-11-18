import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const {
  embedCorsHeaders,
  embedCorsPreflight,
  embedProductIdFromPath,
  isEmbedOriginAllowed,
} = await jiti.import("./embed-cors.ts");

const profile = {
  id: "demo",
  name: "Demo",
  allowedCommands: [],
  allowedOrigins: ["https://app.example.com"],
  enabled: true,
};

test("extracts product ids only from product API paths", () => {
  assert.equal(embedProductIdFromPath("/api/embed/products/demo/projects"), "demo");
  assert.equal(embedProductIdFromPath("/api/embed/products/demo/agent/machines"), "demo");
  assert.equal(embedProductIdFromPath("/api/embed/products"), null);
  assert.equal(embedProductIdFromPath("/api/embed/auth"), null);
});

test("checks product origins and builds CORS headers", () => {
  assert.equal(isEmbedOriginAllowed(profile, "https://app.example.com"), true);
  assert.equal(isEmbedOriginAllowed(profile, "https://evil.example.com"), false);
  assert.equal(isEmbedOriginAllowed({ ...profile, allowedOrigins: [] }, "https://evil.example.com"), true);

  const allowed = embedCorsHeaders(
    new Request("https://pi.example.com/api/embed/products/demo/projects", {
      headers: { origin: "https://app.example.com" },
    }),
    profile,
  );
  assert.equal(allowed["Access-Control-Allow-Origin"], "https://app.example.com");
  const any = embedCorsHeaders(
    new Request("https://pi.example.com/api/embed/products/demo/projects", {
      headers: { origin: "https://evil.example.com" },
    }),
    { ...profile, allowedOrigins: [] },
  );
  assert.equal(any["Access-Control-Allow-Origin"], "*");
});

test("answers preflight with methods and headers, and rejects disallowed origins", () => {
  const ok = embedCorsPreflight(
    new Request("https://pi.example.com/api/embed/products/demo/projects", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    }),
    profile,
  );
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.match(ok.headers.get("access-control-allow-headers") ?? "", /X-Platform-API-Key/);

  const denied = embedCorsPreflight(
    new Request("https://pi.example.com/api/embed/products/demo/projects", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com" },
    }),
    profile,
  );
  assert.equal(denied.status, 403);
});
