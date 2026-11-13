import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test.after(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});
