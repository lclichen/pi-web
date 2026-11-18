import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-product-api-"));
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_AUTH;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { saveEmbedProfiles } = await jiti.import("../../../../../../lib/embed-profiles.ts");
const projectsRoute = await jiti.import("./route.ts");
const openRoute = await jiti.import("./[projectId]/open/route.ts");

saveEmbedProfiles([
  {
    id: "demo",
    name: "Demo",
    allowedCommands: ["compact"],
    allowedOrigins: [],
    enabled: true,
    configBundle: null,
    defaultMode: "sandbox",
  },
]);

const HOST = "127.0.0.1:30141";
function request(path, init = {}) {
  return new Request(`http://${HOST}${path}`, {
    ...init,
    headers: { host: HOST, ...(init.headers ?? {}) },
  });
}

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("creates/reuses a project and opens it with a short access token", async () => {
  const body = JSON.stringify({ clientId: "device-1", externalRef: "default", name: "Product Workspace" });
  const created = await projectsRoute.POST(
    request("/api/embed/products/demo/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ productId: "demo" }) },
  );
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = await created.json();
  assert.equal(createdBody.reused, false);
  assert.match(createdBody.embedUrl, /\/embed\/p\//);

  const reused = await projectsRoute.POST(
    request("/api/embed/products/demo/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ productId: "demo" }) },
  );
  assert.equal(reused.status, 200, await reused.clone().text());
  const reusedBody = await reused.json();
  assert.equal(reusedBody.reused, true);
  assert.equal(reusedBody.project.id, createdBody.project.id);

  const list = await projectsRoute.GET(request("/api/embed/products/demo/projects?clientId=device-1"), {
    params: Promise.resolve({ productId: "demo" }),
  });
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.deepEqual(
    listed.projects.map((project) => project.id),
    [createdBody.project.id],
  );

  const opened = await openRoute.POST(
    request(`/api/embed/products/demo/projects/${createdBody.project.id}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    }),
    { params: Promise.resolve({ productId: "demo", projectId: createdBody.project.id }) },
  );
  assert.equal(opened.status, 200, await opened.clone().text());
  const openBody = await opened.json();
  assert.match(openBody.url, /#token=emba_/);
  assert.equal(openBody.project.id, createdBody.project.id);
  assert.equal(openBody.project.mode, "sandbox");
});

test("rejects a user outside the product group", async () => {
  saveEmbedProfiles([
    {
      id: "restricted",
      name: "Restricted",
      allowedCommands: [],
      allowedOrigins: [],
      enabled: true,
      members: [1],
      defaultMode: "sandbox",
    },
  ]);
  const response = await projectsRoute.GET(request("/api/embed/products/restricted/projects"), {
    params: Promise.resolve({ productId: "restricted" }),
  });
  assert.equal(response.status, 403);
});
