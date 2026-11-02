import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "share-tool-"));
process.env.PI_WEB_PUBLIC_URL = "http://test.local";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const { makeShareFileExtension } = await jiti.import("./share.ts");
const store = await jiti.import("../share-store.ts");

const ws = mkdtempSync(join(tmpdir(), "share-ws-"));
writeFileSync(join(ws, "report.pdf"), Buffer.alloc(64, 7));
mkdirSync(join(ws, "sub"));
writeFileSync(join(ws, "sub", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

/** Minimal ExtensionAPI stub: capture the registered tool + session_start. */
function harness(opts) {
  const registered = [];
  const hooks = {};
  const pi = {
    on: (event, handler) => {
      hooks[event] = handler;
    },
    registerTool: (tool) => registered.push(tool),
  };
  makeShareFileExtension(opts)(pi);
  return { tool: registered[0], hooks, registered };
}

/**
 * share_file 工具（Agent 会话内入口）：host 模式实测（栅栏/创建/URL），
 * 远程模式的读取通道走 remoteReadBinary——这里用形状断言锁定接线。
 */

test("host mode: creates a live share fenced to the session cwd", async () => {
  const { tool, hooks } = harness({ ownerId: 5, ownerName: "alice", mode: "host", cwd: ws });
  assert.equal(tool.name, "share_file");
  // session_start wires the session id (used for audit) — trimmed contexts skip.
  await hooks.session_start({}, { sessionManager: { getSessionId: () => "sess-1" } });

  const result = await tool.execute("t1", { path: "report.pdf" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /http:\/\/test\.local\/api\/share\/[A-Za-z0-9_-]{22}/);
  assert.equal(result.details.kind, "host");

  const url = result.details.url;
  const token = url.split("/").pop();
  const lookup = store.lookupShare(token);
  assert.equal(lookup.status, "ok");
  assert.equal(lookup.entry.ownerId, 5);
  assert.equal(lookup.entry.sessionId, "sess-1");
  assert.equal(lookup.entry.hostRoot, ws);
});

test("host mode: absolute paths inside the workspace work; outside is rejected", async () => {
  const { tool } = harness({ ownerId: 5, ownerName: "alice", mode: "host", cwd: ws });
  const ok = await tool.execute("t2", { path: join(ws, "sub", "pic.png"), ttl_minutes: 5 });
  assert.equal(ok.details.kind, "host");

  const outside = mkdtempSync(join(tmpdir(), "share-out-"));
  writeFileSync(join(outside, "x.txt"), "x");
  const bad = await tool.execute("t3", { path: join(outside, "x.txt") });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /超出会话工作区/);

  const missing = await tool.execute("t4", { path: "nope.txt" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /文件不存在/);
  rmSync(outside, { recursive: true, force: true });
});

test("trimmed contexts: session_start without a session manager must not throw", async () => {
  const { hooks } = harness({ ownerId: 5, ownerName: "alice", mode: "host", cwd: ws });
  await hooks.session_start({}, {});
});

test("wiring: agent/new and restore options inject the tool for all modes except quick", async () => {
  const newRoute = await readFile(new URL("../../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const restore = await readFile(new URL("../session-restore-options.ts", import.meta.url), "utf8");
  for (const source of [newRoute, restore]) {
    assert.match(source, /makeShareFileExtension\(\{/);
    assert.match(source, /mode !== "quick"/);
  }
  // The remote read channel is shared with remotefs (snapshot at creation).
  assert.match(await readFile(new URL("./share.ts", import.meta.url), "utf8"), /remoteReadBinary/);
  // Absolute links honour the admin-configured public base URL.
  assert.match(await readFile(new URL("./share.ts", import.meta.url), "utf8"), /getPublicBaseUrl/);
});
