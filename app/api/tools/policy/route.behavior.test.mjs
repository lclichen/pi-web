import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * /api/tools/policy 真实 handler 行为测试：
 * 模式解析（host vs sandbox 项目）、MCP 传输/声明分流、门禁。
 */
process.env.PI_WEB_AUTH = "";
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-tool-policy-data-"));
process.env.PI_WEB_DATA_DIR = DATA_DIR;
const PROJECT_ID = "qa-tool-policy";

const sandboxHome = join(DATA_DIR, "sandbox-homes", "u0", PROJECT_ID);
mkdirSync(join(sandboxHome, ".pi"), { recursive: true });
writeFileSync(
  join(DATA_DIR, "projects.json"),
  JSON.stringify({
    version: 1,
    projects: {
      [PROJECT_ID]: {
        id: PROJECT_ID,
        name: "qa-tool-policy",
        ownerId: 0,
        mode: "sandbox",
        createdAt: 1,
        pinnedSessions: [],
      },
    },
  }),
);
writeFileSync(
  join(sandboxHome, ".pi", "mcp.json"),
  JSON.stringify({
    mcpServers: {
      guardstdio: { command: "npx", args: ["-y", "guard-stdio"], directTools: true },
      guardhttp: { url: "https://mcp.example/api" },
      guardexempt: { command: "npx", args: ["-y", "guard-exempt"], piWeb: { plane: "host" } },
      guardws: { url: "https://mcp.example/fs", piWeb: { plane: "workspace", pathParams: ["path"] } },
      guardoff: { url: "https://mcp.example/off", disabled: true },
    },
  }),
);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route.ts");
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("@/lib/web-session.ts");

const HOST = "127.0.0.1:30141";

function req(path, { host = HOST } = {}) {
  return new Request(`http://${host}${path}`, { headers: { host } });
}

test("host-directory cwd resolves to host mode with the full declaration matrix", async () => {
  const res = await GET(req(`/api/tools/policy?cwd=${encodeURIComponent(DATA_DIR)}`));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.cwd, DATA_DIR);
  assert.equal(data.mode, "host");
  assert.equal(data.remote, false);
  assert.equal(data.tools.length, 21);
  const powershell = data.tools.find((tool) => tool.name === "powershell");
  assert.deepEqual(powershell.remote, {
    sandbox: "unsupported",
    "local-machine": "unsupported",
    ssh: "unsupported",
  });
});

test("sandbox project cwd clamps stdio/workspace MCP but keeps HTTP and explicit host exemption", async () => {
  const res = await GET(req(`/api/tools/policy?cwd=${encodeURIComponent(sandboxHome)}`));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "sandbox");
  assert.equal(data.remote, true);

  const byName = new Map(data.mcp.map((server) => [server.name, server]));
  const stdio = byName.get("guardstdio");
  assert.ok(stdio, "project stdio server should be listed");
  assert.equal(stdio.transport, "stdio");
  assert.equal(stdio.excludedInMode, true);
  assert.match(stdio.reason, /宿主|沙盒逃逸/);

  const http = byName.get("guardhttp");
  assert.equal(http.transport, "http");
  assert.equal(http.excludedInMode, false);

  const exempt = byName.get("guardexempt");
  assert.deepEqual(exempt.declaration, { plane: "host" });
  assert.equal(exempt.excludedInMode, false, "plane=host is an explicit exemption");

  const workspace = byName.get("guardws");
  assert.deepEqual(workspace.declaration.plane, "workspace");
  assert.equal(workspace.excludedInMode, true);
  assert.match(workspace.reason, /workspace|P3/);

  assert.equal(byName.get("guardoff").disabled, true);
});

test("rejects missing cwd and untrusted hosts", async () => {
  const missing = await GET(req("/api/tools/policy"));
  assert.equal(missing.status, 400);

  const untrusted = await GET(
    req(`/api/tools/policy?cwd=${encodeURIComponent(sandboxHome)}`, { host: "evil.example.com" }),
  );
  assert.equal(untrusted.status, 403);
});

test("auth-on: users only use their own project homes; admins can read any project", async () => {
  const projectId = "qa-tool-policy-u2";
  const home = join(DATA_DIR, "sandbox-homes", "u2", projectId);
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { userstdio: { command: "npx", args: ["-y", "x"] } } }),
  );
  const projects = JSON.parse(readFileSync(join(DATA_DIR, "projects.json"), "utf8"));
  projects.projects[projectId] = {
    id: projectId,
    name: "p-u2",
    ownerId: 2,
    mode: "sandbox",
    createdAt: 2,
    pinnedSessions: [],
  };
  writeFileSync(join(DATA_DIR, "projects.json"), JSON.stringify(projects));

  const session = (id, role) =>
    createWebSession({ id, username: `u${id}`, email: null, role, status: "active" }, "sk_test", "").sid;
  const u2 = session(2, "user");
  const u3 = session(3, "user");
  const admin = session(1, "admin");
  const withCookie = (sid, cwd) =>
    GET(
      new Request(`http://${HOST}/api/tools/policy?cwd=${encodeURIComponent(cwd)}`, {
        headers: { host: HOST, cookie: `${WEB_SESSION_COOKIE}=${sid}` },
      }),
    );

  const previousAuth = process.env.PI_WEB_AUTH;
  process.env.PI_WEB_AUTH = "on";
  try {
    assert.equal((await GET(req(`/api/tools/policy?cwd=${encodeURIComponent(home)}`))).status, 401);

    const own = await withCookie(u2, home);
    assert.equal(own.status, 200);
    const ownData = await own.json();
    assert.equal(ownData.mode, "sandbox");
    assert.equal(ownData.mcp.find((server) => server.name === "userstdio")?.excludedInMode, true);

    // Host 空间仅管理员
    assert.equal((await withCookie(u2, DATA_DIR)).status, 403);
    // 别人的项目不可读
    assert.equal((await withCookie(u3, home)).status, 403);
    // 管理员可读任意项目
    assert.equal((await withCookie(admin, home)).status, 200);
  } finally {
    process.env.PI_WEB_AUTH = previousAuth ?? "";
  }
});

test.after(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});
