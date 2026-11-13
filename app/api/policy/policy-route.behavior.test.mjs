import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * /api/policy 真实 handler 行为测试（此前只有源级契约）。
 * auth off = 隐式 host admin（user 0），raw cwd 放行，因此可直调 handler。
 */
process.env.PI_WEB_AUTH = "";
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-policy-data-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT, DELETE, POST } = await jiti.import("./route.ts");

const HOST = "127.0.0.1:30141";

function req(method, path, { json, headers = {}, host = HOST } = {}) {
  return new Request(`http://${host}${path}`, {
    method,
    headers: {
      host,
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

function workdir(name) {
  const dir = mkdtempSync(join(tmpdir(), `pi-web-policy-${name}-`));
  return dir;
}

async function body(res) {
  return res.json();
}

test("GET returns defaults and is editable for the implicit host admin", async () => {
  const cwd = workdir("get");
  const res = await GET(req("GET", `/api/policy?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data.cwd, cwd);
  assert.equal(data.policyFilePresent, false);
  assert.deepEqual(data.policy.allowWrite, ["."]);
  assert.equal(data.policy.askOnOutsideWrite, true);
  assert.equal(data.editable, true);
  assert.equal(data.scope, null);
});

test("GET rejects missing cwd and untrusted hosts", async () => {
  const missing = await GET(req("GET", "/api/policy"));
  assert.equal(missing.status, 400);
  assert.match((await body(missing)).error, /absolute path/i);

  const cwd = workdir("host-check");
  const untrusted = await GET(
    req("GET", `/api/policy?cwd=${encodeURIComponent(cwd)}`, { host: "evil.example.com" }),
  );
  assert.equal(untrusted.status, 403);
  assert.match((await body(untrusted)).error, /Untrusted/);
});

test("PUT validates content type/body and persists a normalized policy", async () => {
  const cwd = workdir("put");
  const plain = await PUT(
    req("PUT", `/api/policy?cwd=${encodeURIComponent(cwd)}`, {
      json: { policy: {} },
      headers: { "content-type": "text/plain" },
    }),
  );
  assert.equal(plain.status, 415);

  const badBody = new Request(`http://${HOST}/api/policy?cwd=${encodeURIComponent(cwd)}`, {
    method: "PUT",
    headers: { host: HOST, "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal((await PUT(badBody)).status, 400);

  const res = await PUT(
    req("PUT", `/api/policy?cwd=${encodeURIComponent(cwd)}`, {
      json: {
        policy: {
          version: 1,
          allowWrite: ["src", ""],
          denyWrite: [".env"],
          denyRead: ["secrets/**"],
          askOnOutsideWrite: false,
          unknownField: "dropped",
        },
      },
    }),
  );
  assert.equal(res.status, 200);
  const saved = JSON.parse(readFileSync(join(cwd, ".pi/path-policy.json"), "utf8"));
  assert.deepEqual(saved.allowWrite, ["src"]);
  assert.equal(saved.askOnOutsideWrite, false);
  assert.equal("unknownField" in saved, false);

  const readBack = await body(await GET(req("GET", `/api/policy?cwd=${encodeURIComponent(cwd)}`)));
  assert.equal(readBack.policyFilePresent, true);
  assert.deepEqual(readBack.policy.denyRead, ["secrets/**"]);
});

test("DELETE removes one persisted decision and validates its path", async () => {
  const cwd = workdir("delete");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const entry = { path: `${cwd.replaceAll("\\", "/")}/outside.txt`, decision: "deny", at: 1 };
  writeFileSync(
    join(cwd, ".pi/path-policy.decisions.json"),
    JSON.stringify({ version: 1, entries: [entry] }),
  );

  const relative = await DELETE(req("DELETE", `/api/policy?cwd=${encodeURIComponent(cwd)}&path=outside.txt`));
  assert.equal(relative.status, 400);

  const removed = await DELETE(
    req("DELETE", `/api/policy?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(entry.path)}`),
  );
  assert.equal(removed.status, 200);
  const saved = JSON.parse(readFileSync(join(cwd, ".pi/path-policy.decisions.json"), "utf8"));
  assert.deepEqual(saved.entries, []);

  const again = await DELETE(
    req("DELETE", `/api/policy?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(entry.path)}`),
  );
  assert.equal(again.status, 404);
});

test("POST trial run uses the same guard verdicts (command/path/scope)", async () => {
  const cwd = workdir("trial");
  const outside = join(cwd, "..", `pi-web-trial-${Date.now()}.txt`);

  const ask = await body(
    await POST(
      req("POST", "/api/policy", {
        json: { cwd, command: `echo x > ${outside.replaceAll("\\", "/")}` },
      }),
    ),
  );
  assert.equal(ask.action, "ask", JSON.stringify(ask));

  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi/path-policy.json"),
    JSON.stringify({ version: 1, allowWrite: ["."], denyWrite: [".env"], denyRead: [".env"], askOnOutsideWrite: false }),
  );
  const denyCommand = await body(await POST(req("POST", "/api/policy", { json: { cwd, command: "rm .env" } })));
  assert.equal(denyCommand.action, "deny");
  assert.match(denyCommand.reason, /denyWrite/);

  const denyPath = await body(await POST(req("POST", "/api/policy", { json: { cwd, path: ".env", kind: "read" } })));
  assert.equal(denyPath.action, "deny");
  assert.match(denyPath.reason, /denyRead/);

  const allowPath = await body(await POST(req("POST", "/api/policy", { json: { cwd, path: "src/a.ts", kind: "write" } })));
  assert.equal(allowPath.action, "allow");

  // 远程路径空间：scope 映射后按同一策略判定。
  writeFileSync(
    join(cwd, ".pi/path-policy.scope.json"),
    JSON.stringify({ version: 1, mode: "sandbox", workspaceRoot: "/workspace" }),
  );
  const scoped = await body(
    await POST(req("POST", "/api/policy", { json: { cwd, path: "/workspace/.env", kind: "read" } })),
  );
  assert.equal(scoped.action, "deny");

  const missing = await POST(req("POST", "/api/policy", { json: { cwd } }));
  assert.equal(missing.status, 400);
});

test.after(() => {
  try {
    rmSync(process.env.PI_WEB_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  assert.ok(true);
});
