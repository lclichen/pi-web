import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 「重新连接机器」（本机项目改绑）的服务端两个陷阱：
 *  1. 同一个 PATCH 既换机器又换目录时，目录校验必须打到**新**机器上——旧机器
 *     已解配（机器被重新配对后 machineId 完全变了），拿它校验必然失败；
 *  2. machineId 必须是该用户机器目录里的一台，否则可以把项目绑到别人的机器。
 * 用 jiti 直调真实 handler；relay 连接用 FakeWs + attachAgentSocket 模拟，
 * 机器目录来自临时 PI_CODING_AGENT_DIR 下的 relay.json。
 */
const root = mkdtempSync(join(tmpdir(), "pi-web-project-machine-"));
const previousEnv = {
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
process.env.PI_WEB_DATA_DIR = join(root, "data");
process.env.PI_WEB_AUTH = "on";
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

// 机器目录（持久化 token 记录）：user 1 有 new-machine（稍后上线）和 idle-machine
// （已配对但离线）；user 2 有一台带明显 label 的机器，用于验证归属校验不串用户。
const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "relay.json"),
  JSON.stringify({
    token: null,
    generatedAt: null,
    tokens: {
      "tok-new": {
        userId: 1,
        machineId: "new-machine",
        label: "New box",
        issuedAt: future,
        lastSeenAt: future,
        expiresAt: future,
      },
      "tok-idle": {
        userId: 1,
        machineId: "idle-machine",
        label: "Idle box",
        issuedAt: future,
        lastSeenAt: future,
        expiresAt: future,
      },
      "tok-other": {
        userId: 2,
        machineId: "other-machine",
        label: "SecretBox",
        issuedAt: future,
        lastSeenAt: future,
        expiresAt: future,
      },
    },
  }),
  { mode: 0o600 },
);

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("@/lib/web-session.ts");
const { createProject } = await jiti.import("@/lib/projects");
const { attachAgentSocket } = await jiti.import("@/lib/relay/registry");
const { PATCH } = await jiti.import("./route.ts");
const { GET: GET_MACHINE } = await jiti.import("./machine/route.ts");

/** Minimal WebSocket double: answers rpc frames the way the agent would. */
class FakeAgentWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.seenMethods = [];
  }
  send(raw) {
    const req = JSON.parse(raw);
    this.seenMethods.push(req.method);
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
  // hello 是可选帧；attachAgentSocket 先放占位 info，这里补上真实版本 + base 能力。
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

function sessionCookie(user) {
  const session = createWebSession({ ...user, email: null, status: "active" }, "sk_test", 1);
  return `${WEB_SESSION_COOKIE}=${session.sid}`;
}

const adminCookie = () => sessionCookie({ id: 1, username: "admin", role: "admin" });
const otherCookie = () => sessionCookie({ id: 2, username: "other", role: "user" });

function patchRequest(projectId, body, cookie = adminCookie()) {
  return new Request(`http://localhost/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function machineRequest(projectId, cookie) {
  return new Request(`http://localhost/api/projects/${projectId}/machine`, {
    method: "GET",
    headers: { host: "localhost", cookie },
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

test("同一请求既换机器又换目录：目录校验打在新机器上", async () => {
  const created = await createProject({
    name: "reconnect-happy",
    ownerId: 1,
    mode: "local-machine",
    machineId: "old-machine",
    workdir: "/old/dir",
  });
  assert.equal(created.ok, true);
  const project = created.project;
  // 旧机器不在机器目录里（已解配）；新机器已配对且在线。
  const ws = attachOnlineMachine(1, "new-machine");

  const res = await PATCH(
    patchRequest(project.id, { machineId: "new-machine", workdir: "/srv/new-dir" }),
    routeCtx(project.id),
  );
  const body = await res.json();
  assert.equal(res.status, 200, `预期 200，实际 ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.project.machineId, "new-machine");
  assert.equal(body.project.previousMachineId, "old-machine", "改绑前的机器被记下来（供撤销）");
  assert.equal("workdir" in body.project, false, "workdir 仍不从 publicProject 泄漏");
  assert.ok(ws.seenMethods.includes("fs.stat"), "目录校验发给了新机器上的 agent");

  const detailRes = await GET_MACHINE(machineRequest(project.id, adminCookie()), routeCtx(project.id));
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.machineId, "new-machine");
  assert.equal(detail.workdir, "/srv/new-dir");
});

test("绑定不属于本用户的 machineId 返回 400，记录不变", async () => {
  const created = await createProject({
    name: "reconnect-foreign",
    ownerId: 1,
    mode: "local-machine",
    machineId: "old-machine",
    workdir: "/old/dir",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  const res = await PATCH(patchRequest(project.id, { machineId: "other-machine" }), routeCtx(project.id));
  const body = await res.json();
  assert.equal(res.status, 400);
  // 错误信息不回显机器名 / 机器 id（不泄漏别的用户的信息）。
  assert.doesNotMatch(String(body.error), /SecretBox|other-machine/);

  const detail = await (await GET_MACHINE(machineRequest(project.id, adminCookie()), routeCtx(project.id))).json();
  assert.equal(detail.machineId, "old-machine", "绑定未被改动");
  assert.equal(detail.workdir, "/old/dir");
});

test("已配对但离线的机器可以只改绑（不提交目录时不校验）", async () => {
  const created = await createProject({
    name: "reconnect-offline",
    ownerId: 1,
    mode: "local-machine",
    machineId: "old-machine",
    workdir: "/old/dir",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  const res = await PATCH(patchRequest(project.id, { machineId: "idle-machine" }), routeCtx(project.id));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.project.machineId, "idle-machine");
  assert.equal(body.project.previousMachineId, "old-machine");
});

test("非改绑 PATCH 不触碰 previousMachineId", async () => {
  const created = await createProject({
    name: "reconnect-rename",
    ownerId: 1,
    mode: "local-machine",
    machineId: "new-machine",
    workdir: "/srv/rename",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  const res = await PATCH(patchRequest(project.id, { name: "reconnect-renamed" }), routeCtx(project.id));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.project.name, "reconnect-renamed");
  assert.equal("previousMachineId" in body.project, false);
});

test("重复提交同一台机器不会把 previousMachineId 覆盖成当前机器", async () => {
  const created = await createProject({
    name: "reconnect-same-machine",
    ownerId: 1,
    mode: "local-machine",
    machineId: "old-machine",
    workdir: "/srv/same",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  // 第一次改绑：old-machine → new-machine，previous = old-machine。
  const first = await PATCH(patchRequest(project.id, { machineId: "new-machine" }), routeCtx(project.id));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).project.previousMachineId, "old-machine");

  // 同一机器的重复提交（幂等）：previous 保持 old-machine，不变成 new-machine。
  const again = await PATCH(patchRequest(project.id, { machineId: "new-machine" }), routeCtx(project.id));
  const body = await again.json();
  assert.equal(again.status, 200, JSON.stringify(body));
  assert.equal(body.project.machineId, "new-machine");
  assert.equal(body.project.previousMachineId, "old-machine");
});

test("workdir 只返回给项目属主：admin 读别人的项目仍 404", async () => {
  const created = await createProject({
    name: "reconnect-owner-only",
    ownerId: 2,
    mode: "local-machine",
    machineId: "other-machine",
    workdir: "/home/other/secret",
  });
  assert.equal(created.ok, true);
  const project = created.project;

  const denied = await GET_MACHINE(machineRequest(project.id, adminCookie()), routeCtx(project.id));
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).workdir, undefined);

  const allowed = await GET_MACHINE(machineRequest(project.id, otherCookie()), routeCtx(project.id));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).workdir, "/home/other/secret");
});
