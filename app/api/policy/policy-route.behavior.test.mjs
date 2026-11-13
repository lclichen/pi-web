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
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-policy-data-"));
process.env.PI_WEB_DATA_DIR = DATA_DIR;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT, DELETE, POST } = await jiti.import("./route.ts");
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("@/lib/web-session.ts");

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

/** auth-on 夹具：直接创建真实 web 会话（绕过平台登录）。 */
function createUserSession(id, role) {
  return createWebSession(
    { id, username: `u${id}`, email: null, role, status: "active" },
    "sk_test",
    "",
  ).sid;
}

function cookieReq(sid, method, path, opts = {}) {
  return req(method, path, {
    ...opts,
    headers: { ...(opts.headers ?? {}), cookie: `${WEB_SESSION_COOKIE}=${sid}` },
  });
}

function enc(value) {
  return encodeURIComponent(value);
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

test("auth-on: project policy locks for users, host dirs are admin-only, admin can edit", async () => {
  const projectId = "policy-proj-u2";
  const home = join(DATA_DIR, "sandbox-homes", "u2", projectId);
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(
    join(DATA_DIR, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [projectId]: {
          id: projectId,
          name: "p2",
          ownerId: 2,
          mode: "sandbox",
          createdAt: 1,
          pinnedSessions: [],
        },
      },
    }),
  );

  const u2 = createUserSession(2, "user");
  const u3 = createUserSession(3, "user");
  const admin = createUserSession(1, "admin");
  const previousAuth = process.env.PI_WEB_AUTH;
  process.env.PI_WEB_AUTH = "on";
  try {
    // 无 cookie → 401
    assert.equal((await GET(req("GET", `/api/policy?cwd=${enc(home)}`))).status, 401);

    // 普通用户自己的项目 home：可读、锁定
    const own = await GET(cookieReq(u2, "GET", `/api/policy?cwd=${enc(home)}`));
    assert.equal(own.status, 200);
    const ownData = await own.json();
    assert.equal(ownData.editable, false);
    assert.equal(ownData.lockReason, "project:sandbox");

    // 锁定的项目策略：PUT 403
    const lockedPut = await PUT(
      cookieReq(u2, "PUT", `/api/policy?cwd=${enc(home)}`, { json: { policy: { allowWrite: ["/"] } } }),
    );
    assert.equal(lockedPut.status, 403);
    assert.match((await lockedPut.json()).error, /锁定|配置包/);

    // 普通用户不可用服务器目录（Host 空间）
    assert.equal((await GET(cookieReq(u2, "GET", `/api/policy?cwd=${enc(DATA_DIR)}`))).status, 403);

    // 普通用户不可读别人的项目 home
    const foreign = await GET(cookieReq(u3, "GET", `/api/policy?cwd=${enc(home)}`));
    assert.equal(foreign.status, 403);

    // 管理员可读可改项目策略
    const adminGet = await GET(cookieReq(admin, "GET", `/api/policy?cwd=${enc(home)}`));
    assert.equal(adminGet.status, 200);
    assert.equal((await adminGet.json()).editable, true);
    const adminPut = await PUT(
      cookieReq(admin, "PUT", `/api/policy?cwd=${enc(home)}`, {
        json: { policy: { version: 1, allowWrite: ["src"], denyWrite: [], denyRead: [], askOnOutsideWrite: false } },
      }),
    );
    assert.equal(adminPut.status, 200);

    // 决策记录即使项目锁定也可由属主移除
    const decisionPath = `${home.replaceAll("\\", "/")}/outside.txt`;
    writeFileSync(
      join(home, ".pi/path-policy.decisions.json"),
      JSON.stringify({ version: 1, entries: [{ path: decisionPath, decision: "deny", at: 1 }] }),
    );
    const removed = await DELETE(
      cookieReq(u2, "DELETE", `/api/policy?cwd=${enc(home)}&path=${enc(decisionPath)}`),
    );
    assert.equal(removed.status, 200);
  } finally {
    process.env.PI_WEB_AUTH = previousAuth ?? "";
  }
});

test.after(() => {
  try {
    rmSync(process.env.PI_WEB_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  assert.ok(true);
});
