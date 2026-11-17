import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-profile-routes-"));
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_AUTH;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { GET: listProducts } = await jiti.import("../products/route.ts");
const { GET: getProfiles, PUT: putProfiles } = await jiti.import("../../admin/embed-profiles/route.ts");

const HOST = "127.0.0.1:30141";
function request(path, init = {}) {
  return new Request(`http://${HOST}${path}`, {
    ...init,
    headers: { host: HOST, ...(init.headers ?? {}) },
  });
}

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("lists enabled products for link creation", async () => {
  const response = await listProducts(request("/api/embed/products"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(
    data.products.map((product) => product.id),
    ["default"],
  );
});

test("admins replace product profiles and invalid input is rejected", async () => {
  const saved = await putProfiles(
    request("/api/admin/embed-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products: [
          {
            id: "crm",
            name: "CRM",
            allowedCommands: ["compact"],
            allowedOrigins: ["https://crm.example.com"],
            enabled: true,
          },
          { id: "off", name: "Off", allowedCommands: [], allowedOrigins: [], enabled: false },
        ],
      }),
    }),
  );
  assert.equal(saved.status, 200, await saved.clone().text());
  const products = await (await listProducts(request("/api/embed/products"))).json();
  assert.deepEqual(
    products.products.map((product) => product.id),
    ["crm"],
  );

  const adminView = await (await getProfiles(request("/api/admin/embed-profiles"))).json();
  assert.equal(adminView.products.length, 2);

  const invalid = await putProfiles(
    request("/api/admin/embed-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ products: [{ id: "bad id", name: "Bad", allowedCommands: [], allowedOrigins: [] }] }),
    }),
  );
  assert.equal(invalid.status, 400);
});
