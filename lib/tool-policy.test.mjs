import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  filterToolsForMode,
  filterActiveToolsForMode,
  mcpServerModePolicy,
  mcpExcludedServers,
  isRemoteMode,
  isToolOfServer,
  isNoticeableToolExclusion,
  MCP_GATEWAY_TOOL_NAMES,
} = await jiti.import("../lib/tool-policy.ts");

/**
 * P1 模式钳制（docs/dev/tool-guardrails-design.md §7 P1）：
 * 声明工具的模式兼容 + MCP 服务器的远端默认剔除（HTTP 优先 / stdio 落宿主）
 * + 网关元工具随剔除停用。
 */

test("remote modes are exactly sandbox/ssh/local-machine", () => {
  assert.deepEqual(
    ["host", "quick", "sandbox", "ssh", "local-machine"].filter(isRemoteMode),
    ["sandbox", "ssh", "local-machine"],
  );
});

test("declared tools: manifest unsupported channels are clamped in remote modes", () => {
  const names = ["read", "bash", "powershell", "todo", "bg_run"];
  // 固定 win32：powershell 平台相关，本测试只验证模式维度（平台维度见下个测试）。
  // host/quick：不过滤（filter 无副作用；quick 另有封闭世界钳制）。
  for (const mode of ["host", "quick"]) {
    const { allowed, excluded } = filterToolsForMode(names, mode, "win32");
    assert.deepEqual(allowed, names, mode);
    assert.equal(excluded.length, 0, mode);
  }
  // 远端三模式：powershell（三通道 unsupported）被剔除，其余保留。
  for (const mode of ["sandbox", "ssh", "local-machine"]) {
    const { allowed, excluded } = filterToolsForMode(names, mode, "win32");
    assert.deepEqual(allowed, ["read", "bash", "todo", "bg_run"], mode);
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].name, "powershell");
    assert.equal(excluded[0].kind, undefined, mode);
    assert.match(excluded[0].reason, /unsupported/);
  }
});

test("platform-irrelevant tools: runtime clamp restored, notice stays silent (P2-4)", () => {
  // Linux 上 powershell 注册但不可用：活动集剔除（钳制不依赖 pi SDK 抛错），
  // 但 kind=platform 的剔除不进“被禁用”提示（钳制与 UI 噪音解耦）。
  const linux = filterToolsForMode(["read", "powershell"], "sandbox", "linux");
  assert.deepEqual(linux.allowed, ["read"]);
  assert.equal(linux.excluded.length, 1);
  assert.equal(linux.excluded[0].name, "powershell");
  assert.equal(linux.excluded[0].kind, "platform");
  assert.match(linux.excluded[0].reason, /linux|platform|平台/);

  // 审查场景（P2-4）：Linux 服务器上 sandbox/ssh 会话的活动集不含 powershell。
  for (const mode of ["sandbox", "ssh", "local-machine"]) {
    const { allowed } = filterToolsForMode(["read", "powershell"], mode, "linux");
    assert.deepEqual(allowed, ["read"], `linux/${mode}`);
  }

  // 平台钳制与模式正交：host 模式同样剔除（宿主上无法执行）。
  const linuxHost = filterToolsForMode(["read", "powershell"], "host", "linux");
  assert.deepEqual(linuxHost.allowed, ["read"]);
  assert.equal(linuxHost.excluded[0].kind, "platform");

  // win32 上 powershell 平台可用：仅保留模式剔除语义（kind 缺省 = mode）。
  const win = filterToolsForMode(["read", "powershell"], "sandbox", "win32");
  assert.deepEqual(win.allowed, ["read"]);
  assert.equal(win.excluded.length, 1);
  assert.equal(win.excluded[0].name, "powershell");
  assert.equal(win.excluded[0].kind, undefined);
  assert.match(win.excluded[0].reason, /unsupported/);

  const active = filterActiveToolsForMode(["read", "powershell", "mcp"], {
    mode: "sandbox",
    excludedMcpServers: new Map(),
    platform: "linux",
  });
  assert.ok(!active.allowed.includes("powershell"), "Linux 活动集不含 powershell");
  assert.deepEqual(active.allowed, ["read", "mcp"]);

  // 展示层契约：平台剔除静默，模式剔除进提示。
  assert.equal(isNoticeableToolExclusion(linux.excluded[0]), false);
  assert.equal(isNoticeableToolExclusion(win.excluded[0]), true);
  const noticed = active.excluded.filter(isNoticeableToolExclusion);
  assert.deepEqual(noticed, [], "纯平台剔除不产生任何提示条目");
});

test("undeclared tools (MCP direct tools etc.) pass the declaration filter untouched", () => {
  const names = ["docsfs_read_file", "mcp", "some_extension_tool"];
  const { allowed, excluded } = filterToolsForMode(names, "sandbox");
  assert.deepEqual(allowed, names);
  assert.equal(excluded.length, 0);
});

test("MCP policy: HTTP passes in remote modes; stdio/socket is clamped by default", () => {
  const stdioEntry = { command: "npx", args: ["-y", "some-mcp"] };
  const httpEntry = { url: "https://mcp.example/api" };
  for (const mode of ["sandbox", "ssh", "local-machine"]) {
    assert.equal(mcpServerModePolicy(httpEntry, "http", mode).excluded, false, `http/${mode}`);
    const stdio = mcpServerModePolicy(stdioEntry, "stdio", mode);
    assert.equal(stdio.excluded, true, `stdio/${mode}`);
    assert.match(stdio.reason, /宿主|沙盒逃逸/);
  }
  // host/quick：维持现状，全部可用。
  for (const mode of ["host", "quick"]) {
    assert.equal(mcpServerModePolicy(stdioEntry, "stdio", mode).excluded, false, `stdio/${mode}`);
    assert.equal(mcpServerModePolicy(httpEntry, "http", mode).excluded, false, `http/${mode}`);
  }
});

test("MCP policy: piWeb.plane host exempts stdio; workspace clamps even over HTTP", () => {
  const exempt = { command: "npx", piWeb: { plane: "host" } };
  assert.equal(mcpServerModePolicy(exempt, "stdio", "sandbox").excluded, false, "管理员显式豁免");
  const workspace = { url: "https://mcp.example/fs", piWeb: { plane: "workspace", pathParams: ["path"] } };
  const decision = mcpServerModePolicy(workspace, "http", "ssh");
  assert.equal(decision.excluded, true, "workspace 声明 P3 前远端不可用");
  assert.match(decision.reason, /P3|workspace/);
  const local = mcpServerModePolicy(workspace, "http", "local-machine");
  assert.match(local.reason, /relay MCP host|project scope/);
});

test("mcpExcludedServers reads the project config and applies per-server declarations", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "stdio-srv": { command: "npx", args: ["-y", "x"] },
          "http-srv": { url: "https://mcp.example/api" },
          "stdio-exempt": { command: "npx", args: ["y"], piWeb: { plane: "host" } },
          "ws-srv": { url: "https://mcp.example/fs", piWeb: { plane: "workspace" } },
          "socket-srv": { socket: "/tmp/rmcp.sock" },
        },
      }),
    );
    const ex = mcpExcludedServers(dir, 0, "sandbox");
    assert.ok(ex.has("stdio-srv"), "未声明 stdio 剔除");
    assert.ok(ex.has("socket-srv"), "socket 视同 stdio（同机进程）");
    assert.ok(!ex.has("http-srv"), "HTTP 默认放行");
    assert.ok(!ex.has("stdio-exempt"), "plane=host 显式豁免");
    assert.ok(ex.has("ws-srv"), "workspace 声明远端剔除");
    assert.equal(mcpExcludedServers(dir, 0, "host").size, 0, "host 模式零剔除");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active-set filter: excluded servers lose direct tools AND the gateway", () => {
  const names = ["read", "bash", "powershell", "mcp", "mcpScript", "docsfs_read_file", "docsfs_write", "other_ping", "todo"];
  const exclusions = new Map([["docsfs", "stdio 落宿主"]]);
  const { allowed, excluded } = filterActiveToolsForMode(names, {
    mode: "sandbox",
    excludedMcpServers: exclusions,
    platform: "win32",
  });
  assert.deepEqual(allowed, ["read", "bash", "other_ping", "todo"]);
  const excludedNames = excluded.map((e) => e.name).sort();
  assert.deepEqual(excludedNames, ["docsfs_read_file", "docsfs_write", "mcp", "mcpScript", "powershell"]);
  // 无剔除时网关保持可用（host 行为不变）。
  const untouched = filterActiveToolsForMode(names, {
    mode: "sandbox",
    excludedMcpServers: new Map(),
    platform: "win32",
  });
  assert.ok(untouched.allowed.includes("mcp"));
  assert.ok(untouched.allowed.includes("docsfs_read_file"));
});

test("server prefix match keeps whole server names (underscores included)", () => {
  assert.equal(isToolOfServer("mcd_tool_1_now_time", "mcd_tool"), true, "服务器名含下划线仍整段匹配");
  assert.equal(isToolOfServer("mcd_tool_1_now_time", "other_tool"), false);
  assert.equal(isToolOfServer("other_ping", "mcd_tool"), false);
  assert.equal(MCP_GATEWAY_TOOL_NAMES.has("mcp"), true);
  assert.equal(MCP_GATEWAY_TOOL_NAMES.has("mcpScript"), true);
});
