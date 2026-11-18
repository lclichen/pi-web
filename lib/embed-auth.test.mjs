import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-auth-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { saveEmbedProfiles } = await jiti.import("./embed-profiles.ts");
const { createProject, projectHome } = await jiti.import("./projects.ts");
const { createEmbedAccessToken } = await jiti.import("./embed-access.ts");
const {
  embedFrameAncestors,
  embedResponseHeaders,
  extractEmbedToken,
  isEmbedApiAllowed,
  resolveEmbedRequest,
} = await jiti.import("./embed-auth.ts");

saveEmbedProfiles([
  {
    id: "crm",
    name: "CRM",
    allowedCommands: ["compact", "skill:foo"],
    allowedOrigins: ["https://crm.example.com"],
    enabled: true,
    members: [1],
    configBundle: null,
    defaultMode: "local-machine",
  },
]);

const created = await createProject({
  name: "CRM Project",
  ownerId: 1,
  ownerName: "alice",
  mode: "sandbox",
  embed: {
    productId: "crm",
    clientId: "device-1",
    externalRef: "default",
    createdAt: Date.now(),
  },
});
assert.equal(created.ok, true);
if (!created.ok) throw new Error(created.error);
const project = created.project;
const { token, record } = createEmbedAccessToken({
  user: { id: 1, username: "alice", email: null, role: "user", status: "active" },
  apiKey: "",
  productId: "crm",
  scope: { kind: "project", projectId: project.id, cwd: projectHome(project) },
  allowedRoots: [projectHome(project)],
  mode: "sandbox",
  label: project.name,
  ttlMs: 60_000,
});

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

function api(path, init = {}) {
  return new Request(`http://127.0.0.1:30141${path}`, init);
}

test("extracts the short-lived access token from bearer, header, and query", () => {
  assert.equal(extractEmbedToken(api("/api/sessions", { headers: { authorization: `Bearer ${token}` } })), token);
  assert.equal(extractEmbedToken(api("/api/agent/x/events?embed_token=" + encodeURIComponent(token))), token);
  assert.equal(extractEmbedToken(api("/api/files/a", { headers: { "x-embed-token": token } })), token);
  assert.equal(extractEmbedToken(api("/api/sessions")), null);
});

test("default-denies project/admin routes but allows session management inside the project", () => {
  assert.equal(isEmbedApiAllowed("GET", "/api/sessions"), true);
  assert.equal(isEmbedApiAllowed("GET", `/api/sessions/${record.id}`), true);
  assert.equal(isEmbedApiAllowed("PATCH", `/api/sessions/${record.id}`), true);
  assert.equal(isEmbedApiAllowed("DELETE", `/api/sessions/${record.id}`), true);
  assert.equal(isEmbedApiAllowed("POST", "/api/agent/new"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/file-index"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/files/a/b"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/remotefs/a?src=x"), true);
  assert.equal(isEmbedApiAllowed("GET", "/api/git/status"), true);

  assert.equal(isEmbedApiAllowed("GET", "/api/sessions/search"), false);
  assert.equal(isEmbedApiAllowed("POST", `/api/sessions/${record.id}/takeover`), false);
  assert.equal(isEmbedApiAllowed("GET", "/api/projects"), false);
  assert.equal(isEmbedApiAllowed("GET", "/api/admin/users"), false);
  assert.equal(isEmbedApiAllowed("GET", "/api/embed/products"), false);
});

test("resolves valid requests and rejects missing/invalid tokens", () => {
  const none = resolveEmbedRequest(api("/api/sessions"));
  assert.equal(none.kind, "none");
  const invalid = resolveEmbedRequest(api("/api/sessions", { headers: { authorization: "Bearer emba_nope" } }));
  assert.equal(invalid.kind, "invalid");
  const ok = resolveEmbedRequest(api("/api/sessions", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") {
    assert.equal(ok.access.record.scope.projectId, project.id);
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
