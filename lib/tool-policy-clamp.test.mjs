import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

/**
 * P1 模式钳制的接线级测试（rpc-manager 的 enforceModeTools）：
 * 用真实 AgentSessionWrapper + 桩 inner 验证——声明工具（powershell）与
 * 被剔除 MCP 服务器（stdio）的直接工具、网关元工具在远端模式下从活动集
 * 消失；host 模式零变化；重复调用幂等。
 */

function makeInner(initialTools, cwd) {
  let active = [...initialTools];
  // 真实 SDK 语义：getAllTools 返回全部已注册工具（不随 active 变化）。
  const registered = [...initialTools];
  return {
    sessionId: "tool-policy-test",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    sessionManager: { getCwd: () => cwd },
    settingsManager: { setProjectTrusted: () => {}, getDefaultTools: () => undefined },
    agent: { state: { systemPrompt: "base-prompt" } },
    extensionRunner: { getRegisteredCommands: () => [], setUIContext: () => {}, emit: async () => {} },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveToolsByName: (names) => {
      active = [...names];
    },
    pendingMessageCount: 0,
    dispose: () => {},
    reload: async () => {},
  };
}

function withProjectConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tp-clamp-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          tpstdio: { command: "npx", args: ["-y", "tpstdio-mcp"] },
          tphttp: { url: "https://mcp.example/api" },
        },
      }),
    );
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("remote mode clamps declared-unsupported tools, stdio MCP direct tools, and the gateway", () => {
  withProjectConfig((cwd) => {
    const inner = makeInner(["read", "powershell", "tpstdio_fetch", "tphttp_ping", "mcp", "todo"], cwd);
    const wrapper = new AgentSessionWrapper(inner);
    wrapper.mode = "sandbox";

    const base = wrapper.enforceModeTools();
    assert.equal(base, "base-prompt", "发生钳制时返回重建后的实时 base（覆盖脏快照）");
    assert.deepEqual(inner.getActiveToolNames(), ["read", "todo", "tphttp_ping"], "HTTP MCP 保留；stdio/网关/powershell 剔除");
    // P2b：剔除报告随 get_state 暴露给 UI（powershell 声明 + stdio 服务器 + 网关）。
    assert.deepEqual(
      wrapper.modeToolExcluded.map((e) => e.name).sort(),
      ["mcp", "powershell", "tpstdio_fetch"],
      "剔除报告完整（含原因字段）",
    );
    assert.ok(wrapper.modeToolExcluded.every((e) => typeof e.reason === "string"));

    // 幂等：再次调用不改变集合、不返回 base。
    assert.equal(wrapper.enforceModeTools(), undefined);
    assert.deepEqual(inner.getActiveToolNames(), ["read", "todo", "tphttp_ping"]);
  });
});

test("host mode is untouched (no clamp, no prompt override)", () => {
  withProjectConfig((cwd) => {
    const names = ["read", "powershell", "tpstdio_fetch", "mcp", "todo"];
    const inner = makeInner(names, cwd);
    const wrapper = new AgentSessionWrapper(inner);
    wrapper.mode = "host";
    assert.equal(wrapper.enforceModeTools(), undefined);
    assert.deepEqual(inner.getActiveToolNames(), names);
    assert.deepEqual(wrapper.modeToolExcluded, [], "host 模式无剔除报告");
  });
});

test("all remote modes share the clamp (sandbox / ssh / local-machine)", () => {
  withProjectConfig((cwd) => {
    for (const mode of ["sandbox", "ssh", "local-machine"]) {
      const inner = makeInner(["bash", "powershell", "tpstdio_fetch", "mcp"], cwd);
      const wrapper = new AgentSessionWrapper(inner);
      wrapper.mode = mode;
      assert.equal(wrapper.enforceModeTools(), "base-prompt", mode);
      assert.deepEqual(inner.getActiveToolNames(), ["bash"], mode);
    }
  });
});

test("no-op input returns undefined without touching the prompt", () => {
  withProjectConfig((cwd) => {
    const inner = makeInner(["read", "bash", "todo"], cwd);
    const wrapper = new AgentSessionWrapper(inner);
    wrapper.mode = "sandbox";
    assert.equal(wrapper.enforceModeTools(), undefined);
    assert.deepEqual(inner.getActiveToolNames(), ["read", "bash", "todo"]);
  });
});
