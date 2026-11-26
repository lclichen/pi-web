import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * auth-off（单用户）下「重新连接机器」的属主语义：
 *  - 隐式 host 身份 userId 0 与 getOwnedProject 一致，能读任意项目（部署从
 *    多用户切回 auth-off 后，旧项目/旧 token 的 ownerId 仍可能非 0）；
 *  - 浏览器侧 getStatus() 仍会列出那台旧机器，PATCH 的机器归属校验不能把它
 *    拒掉。
 * auth-on 下 admin 读别人项目仍 404 的用例在 route.machine.test.mjs。
 */
const root = mkdtempSync(join(tmpdir(), "pi-web-project-machine-authoff-"));
const previousEnv = {
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
process.env.PI_WEB_DATA_DIR = join(root, "data");
process.env.PI_WEB_AUTH = "off";
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

// 历史遗留的机器：token 记录归属 user 7（auth 曾开启过的部署）。
const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "relay.json"),
  JSON.stringify({
    token: null,
    generatedAt: null,
    tokens: {
      "tok-legacy": {
        userId: 7,
        machineId: "legacy-machine",
        label: "Legacy box",
        issuedAt: future,
        lastSeenAt: future,
        expiresAt: future,
      },
    },
  }),
  { mode: 0o600 },
);

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createProject } = await jiti.import("@/lib/projects");
const { attachAgentSocket } = await jiti.import("@/lib/relay/registry");
const { PATCH } = await jiti.import("./route.ts");
const { GET: GET_MACHINE } = await jiti.import("./machine/route.ts");

class FakeAgentWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send(raw) {
    const req = JSON.parse(raw);
    const result = req.method === "fs.stat" ? { exists: true, isDir: true } : null;
    this.emit("message", JSON.stringify({ id: req.id, ok: true, result }));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function attachOnlineMachine(userId, machineId) {
  const ws = new FakeAgentWs();
  attachAgentSocket(ws, userId, machineId);
  ws.emit(
    "message",
    JSON.stringify({
      type: "hello",
      info: {
        hostname: `${machineId}-host`,
        os: "linux",
        arch: "x64",
        workspaceRoot: "/",
        agentVersion: "0.3.0",
        features: ["workspace-base"],
      },
    }),
  );
  return ws;
}

// auth-off：无需 cookie，requireUserIdentity 返回隐式 host（id 0）。
function machineRequest(projectId) {
  return new Request(`http://localhost/api/projects/${projectId}/machine`, {
    method: "GET",
    headers: { host: "localhost" },
  });
}

function patchRequest(projectId, body) {
  return new Request(`http://localhost/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeCtx = (projectId) => ({ params: Promise.resolve({ id: projectId }) });

test.after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rmSync(root, { recursive: true, force: true });
});

test("auth-off：隐式 host 能读 ownerId 非 0 的本机项目机器绑定", async () => {
  const created = await createProject({
    name: "authoff-machine-read",
    ownerId: 7,
    mode: "local-machine",
    machineId: "legacy-machine",
    workdir: "/home/legacy/proj",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  const res = await GET_MACHINE(machineRequest(project.id), routeCtx(project.id));
  const body = await res.json();
  assert.equal(res.status, 200, `预期 200，实际 ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.machineId, "legacy-machine");
  assert.equal(body.workdir, "/home/legacy/proj");
});

test("auth-off：PATCH 改绑到旧 token 归属的已配对机器返回 200", async () => {
  const created = await createProject({
    name: "authoff-machine-rebind",
    ownerId: 7,
    mode: "local-machine",
    machineId: "gone-machine",
    workdir: "/home/legacy/old",
  });
  assert.equal(created.ok, true);
  const project = created.project;
  // 旧机器已不在目录里；legacy-machine 在线（但 token 归属 user 7，不是 0）。
  attachOnlineMachine(7, "legacy-machine");

  const res = await PATCH(
    patchRequest(project.id, { machineId: "legacy-machine", workdir: "/home/legacy/new" }),
    routeCtx(project.id),
  );
  const body = await res.json();
  assert.equal(res.status, 200, `预期 200，实际 ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.project.machineId, "legacy-machine");
  assert.equal(body.project.previousMachineId, "gone-machine");

  const detail = await (await GET_MACHINE(machineRequest(project.id), routeCtx(project.id))).json();
  assert.equal(detail.machineId, "legacy-machine");
  assert.equal(detail.workdir, "/home/legacy/new");
});

test("auth-off：目录里不存在的 machineId 仍然 400", async () => {
  const created = await createProject({
    name: "authoff-machine-unknown",
    ownerId: 7,
    mode: "local-machine",
    machineId: "legacy-machine",
    workdir: "/home/legacy/proj",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  const res = await PATCH(patchRequest(project.id, { machineId: "no-such-machine" }), routeCtx(project.id));
  assert.equal(res.status, 400);
});
