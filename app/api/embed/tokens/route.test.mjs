import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-routes-"));
const workspace = mkdtempSync(join(tmpdir(), "pi-web-embed-workspace-"));
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_PUBLIC_URL = "http://embed.test";
delete process.env.PI_WEB_AUTH;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { GET, POST } = await jiti.import("./route.ts");
const { DELETE } = await jiti.import("./[id]/route.ts");

const HOST = "127.0.0.1:30141";

function request(path, init = {}) {
  return new Request(`http://${HOST}${path}`, {
    ...init,
    headers: { host: HOST, ...(init.headers ?? {}) },
  });
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("creates, lists, and revokes a workspace token without a platform key (auth-off)", async () => {
  const missingProduct = await POST(
    request("/api/embed/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: workspace, productId: "nope" }),
    }),
  );
  assert.equal(missingProduct.status, 400);

  const created = await POST(
    request("/api/embed/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: workspace, productId: "default", ttlMinutes: 60, label: "Demo" }),
    }),
  );
  assert.equal(created.status, 201, await created.clone().text());
  const body = await created.json();
  assert.match(body.url, /^http:\/\/embed\.test\/embed\/emb_/);
  assert.equal(body.label, "Demo");
  const rawToken = body.url.split("/embed/")[1];

  const list = await GET(request("/api/embed/tokens"));
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0].id, body.id);

  // An embed token cannot use the management endpoints it was created from.
  const denied = await GET(
    request("/api/embed/tokens", { headers: { Authorization: `Bearer ${rawToken}` } }),
  );
  assert.equal(denied.status, 403);

  const revoked = await DELETE(request(`/api/embed/tokens/${body.id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: body.id }),
  });
  assert.equal(revoked.status, 204);
  const after = await (await GET(request("/api/embed/tokens"))).json();
  assert.equal(after.tokens.length, 0);
});

test("rejects ambiguous scope and invalid TTL", async () => {
  const both = await POST(
    request("/api/embed/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: workspace, projectId: "p1", productId: "default" }),
    }),
  );
  assert.equal(both.status, 400);
  const ttl = await POST(
    request("/api/embed/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: workspace, productId: "default", ttlMinutes: 1 }),
    }),
  );
  assert.equal(ttl.status, 400);
});
