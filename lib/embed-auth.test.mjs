import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-auth-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const { createEmbedToken } = await import("./embed-tokens.ts");
const { saveEmbedProfiles } = await import("./embed-profiles.ts");
const {
  embedFrameAncestors,
  embedResponseHeaders,
  embedTokenFromPath,
  extractEmbedToken,
  getEmbedPageContext,
  isEmbedApiAllowed,
  resolveEmbedRequest,
} = await import("./embed-auth.ts");

const owner = { id: 1, username: "alice", email: null, role: "user", status: "active" };

saveEmbedProfiles([
  {
    id: "crm",
    name: "CRM",
    allowedCommands: ["compact", "skill:foo"],
    allowedOrigins: ["https://crm.example.com"],
    enabled: true,
  },
]);

const { token, record } = createEmbedToken({
  owner,
  productId: "crm",
  scope: { kind: "host", cwd: "/srv/workspace" },
  allowedRoots: ["/srv/workspace"],
  mode: "host",
  label: "Workspace",
  apiKey: "",
  apiKeyId: "",
  ttlMs: 60_000,
});

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

function api(path, init = {}) {
  return new Request(`http://127.0.0.1:30141${path}`, init);
}

test("extracts the token from bearer, header, query, and page path", () => {
  assert.equal(extractEmbedToken(api("/api/sessions", { headers: { authorization: `Bearer ${token}` } })), token);
  assert.equal(extractEmbedToken(api("/api/agent/x/events?embed_token=" + encodeURIComponent(token))), token);
  assert.equal(extractEmbedToken(api("/api/files/a", { headers: { "x-embed-token": token } })), token);
  assert.equal(embedTokenFromPath(`/embed/${token}`), token);
  assert.equal(embedTokenFromPath("/embed/not-a-token"), null);
  assert.equal(extractEmbedToken(api("/api/sessions")), null);
});

test("default-denies project/admin/session management paths", () => {
  assert.equal(isEmbedApiAllowed("GET", "/api/sessions"), true);
  assert.equal(isEmbedApiAllowed("GET", `/api/sessions/${record.id}`), true);
  assert.equal(isEmbedApiAllowed("GET", `/api/sessions/${record.id}/context`), true);
  assert.equal(isEmbedApiAllowed("GET", `/api/sessions/${record.id}/images/img_abcdef12`), true);
  assert.equal(isEmbedApiAllowed("POST", `/api/agent/${record.id}`), true);
  assert.equal(isEmbedApiAllowed("POST", "/api/agent/new"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/file-index"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/files/a/b"), true);
  assert.equal(isEmbedApiAllowed("POST", "/api/files/a"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/remotefs/a?src=x"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/git/status"), true);

  assert.equal(isEmbedApiAllowed("GET", "/api/sessions/search"), false);
  assert.equal(isEmbedApiAllowed("PATCH", `/api/sessions/${record.id}`), false);
  assert.equal(isEmbedApiAllowed("DELETE", `/api/sessions/${record.id}`), false);
  assert.equal(isEmbedApiAllowed("POST", `/api/sessions/${record.id}/takeover`), false);
  assert.equal(isEmbedApiAllowed("GET", "/api/projects"), false);
  assert.equal(isEmbedApiAllowed("GET", "/api/admin/users"), false);
  assert.equal(isEmbedApiAllowed("GET", "/api/embed/tokens"), false);
});

test("resolves valid requests and rejects missing/invalid tokens", () => {
  const none = resolveEmbedRequest(api("/api/sessions"));
  assert.equal(none.kind, "none");
  const invalid = resolveEmbedRequest(api("/api/sessions", { headers: { authorization: "Bearer emb_nope" } }));
  assert.equal(invalid.kind, "invalid");
  const ok = resolveEmbedRequest(api("/api/sessions", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") {
    assert.equal(ok.access.record.id, record.id);
    assert.deepEqual(ok.access.profile.allowedCommands, ["compact", "skill:foo"]);
  }
});

test("builds frame-ancestors from the product origin allowlist", () => {
  assert.equal(embedFrameAncestors({ allowedOrigins: [] }), "*");
  assert.equal(
    embedFrameAncestors({ allowedOrigins: ["https://crm.example.com", "http://localhost:3000"] }),
    "'self' https://crm.example.com http://localhost:3000",
  );
  const headers = embedResponseHeaders({ allowedOrigins: [] });
  assert.equal(headers["Content-Security-Policy"], "frame-ancestors *;");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
});

test("page context exposes only safe fields", async () => {
  const context = await getEmbedPageContext(token, "session-1");
  assert.ok(context);
  assert.equal(context.product.name, "CRM");
  assert.equal(context.scope.kind, "host");
  assert.equal(context.initialSessionId, "session-1");
  assert.equal("apiKey" in context, false);
  assert.equal(await getEmbedPageContext("emb_missing"), null);
});
