import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * /api/agent/[id] 嵌入命令 type 闸门 route 级测试（P2-6）。
 *
 * 闸门位于 embed 身份解析之后、会话解析 / set_tools 分支 / send 之前，
 * 因此用不存在的会话 id 即可区分拒绝与放行路径，无需任何会话层 mock：
 * - embed token + set_tools / fork / 未知 type → 403 embed_command_denied；
 * - embed token + prompt（同一不存在 id）→ 404 会话不存在（已越过闸门，
 *   走到会话解析），且不带 embed_command_denied；
 * - 普通登录会话（auth off 隐式 host）+ set_tools → 404 Session not found
 *   （不经过闸门，set_tools 分支照常运行）。
 *
 * /api/agent/new 的 embed 分支忽略客户端 toolNames 按仓库源码断言先例
 * （同 lib/rpc-manager.test.mjs 的源码切片手法）校验请求体处理——真建会话
 * 依赖 SDK 全量启动，不适合 route 级测试。
 */

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-fence-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-embed-fence-agent-"));
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_WEB_AUTH;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { POST: postAgentCommand } = await jiti.import("./[id]/route.ts");
const { createProject, projectHome } = await jiti.import("../../../lib/projects.ts");
const { createEmbedAccessToken } = await jiti.import("../../../lib/embed-access.ts");

// 夹具手法与 app/api/sessions/embed-scope.test.mjs 一致：项目锚定 token 作用域。
const created = await createProject({
  name: "Embed Fence Project",
  ownerId: 0,
  ownerName: "host",
  mode: "sandbox",
  embed: { productId: "default", clientId: "c1", externalRef: "fence", createdAt: Date.now() },
});
assert.equal(created.ok, true);
if (!created.ok) throw new Error(created.error);
const project = created.project;

const { token } = createEmbedAccessToken({
  user: { id: 0, username: "host", email: null, role: "admin", status: "active" },
  apiKey: "",
  productId: "default",
  scope: { kind: "project", projectId: project.id, cwd: projectHome(project) },
  allowedRoots: [projectHome(project)],
  mode: "sandbox",
  label: project.name,
  ttlMs: 60_000,
});

const HOST = "127.0.0.1:30141";
const MISSING_SESSION = "embed-fence-missing-session";

function agentPost(sessionId, body, { embed = true } = {}) {
  const headers = { host: HOST, "Content-Type": "application/json" };
  if (embed) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://${HOST}/api/agent/${sessionId}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function post(sessionId, body, options) {
  const res = await postAgentCommand(agentPost(sessionId, body, options), {
    params: Promise.resolve({ id: sessionId }),
  });
  return { status: res.status, data: JSON.parse(await res.text()) };
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

test("embed token cannot send set_tools / fork / unknown command types", async () => {
  for (const type of ["set_tools", "fork", "apply_preferences", "ensure_session"]) {
    const body = type === "set_tools" ? { type, toolNames: ["bash"] } : { type };
    const { status, data } = await post(MISSING_SESSION, body);
    assert.equal(status, 403, `${type}: ${JSON.stringify(data)}`);
    assert.equal(data.code, "embed_command_denied", type);
    assert.match(data.error, /未对当前产品开放/, type);
  }
});

test("embed token prompt passes the type gate and reaches session resolution", async () => {
  const { status, data } = await post(MISSING_SESSION, { type: "prompt", message: "hello" });
  // 闸门放行后才走到会话解析：不存在的会话 → 404 会话不存在（而非 403
  // embed_command_denied），证明 prompt 不在拒绝路径上。
  assert.equal(status, 404, JSON.stringify(data));
  assert.equal(data.error, "会话不存在");
  assert.equal(data.code, undefined);
});

test("non-embed callers are not affected by the embed command gate", async () => {
  // auth off → 隐式 host admin（无 embed 作用域）：set_tools 不被闸门拦截，
  // set_tools 分支照常运行（未知会话 → 404 Session not found）。
  const { status, data } = await post(MISSING_SESSION, { type: "set_tools", toolNames: [] }, { embed: false });
  assert.equal(status, 404, JSON.stringify(data));
  assert.equal(data.code, undefined);
  assert.equal(data.error, "Session not found");
});

test("embed branch of /api/agent/new drops client toolNames before session creation", async () => {
  const source = await readFile(new URL("./new/route.ts", import.meta.url), "utf8");
  const embedBranchStart = source.indexOf("const embed = identity.session.embed;");
  const embedBranchEnd = source.indexOf("const { cwd, ...command } = body;");
  assert.ok(embedBranchStart >= 0 && embedBranchEnd > embedBranchStart, "embed branch not found in route source");
  const embedBranch = source.slice(embedBranchStart, embedBranchEnd);
  // 嵌入会话工具档位由服务端产品配置决定：客户端 toolNames 在进入会话创建
  // 之前被删除（toolNames 在 new 路由里唯一的消费点是 startRpcSession 选项）。
  assert.match(embedBranch, /delete body\.toolNames;/);
  assert.match(embedBranch, /delete body\.mode;/);
  assert.match(embedBranch, /body\.projectId = embed\.scope\.projectId;/);
});
