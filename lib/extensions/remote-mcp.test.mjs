import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { assertRelayWorkspaceMcpSafe, makeRemoteMcpToolsExtension, relayMcpToolName, isRelayWorkspaceServer } =
  await jiti.import("./remote-mcp.ts");

const AGENT = {
  info: {
    agentVersion: "0.8.0",
    features: ["workspace-base", "mcp-relay-v1"],
  },
};

function projectHomeWith(config) {
  const home = mkdtempSync(join(tmpdir(), "relay-mcp-home-"));
  mkdirSync(join(home, ".pi"), { recursive: true });
  // Older fixtures predate the adapter-safety pair; fill only missing fields
  // so the explicitly-unsafe guard test still keeps its eager values.
  for (const entry of Object.values(config.mcpServers ?? {})) {
    if (entry?.piWeb?.plane === "workspace" && entry.command) {
      if (entry.lifecycle === undefined) entry.lifecycle = "lazy";
      if (entry.directTools === undefined) entry.directTools = false;
    }
  }
  writeFileSync(join(home, ".pi", "mcp.json"), JSON.stringify(config, null, 2));
  return home;
}

function harness({ home, calls, agent = AGENT, respond } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const rpcCalls = calls ?? [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
  };
  const rpc = async (method, params, opts) => {
    rpcCalls.push({ method, params, opts });
    if (respond) return respond(method, params);
    if (method === "mcp.listTools") {
      return {
        serverKey: params.serverKey,
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "picture",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }
    if (method === "mcp.callTool") {
      if (params.name === "picture") {
        return { content: [{ type: "image", data: "aW1n", mimeType: "image/png" }] };
      }
      return { content: [{ type: "text", text: `echo:${params.arguments?.text ?? ""}` }] };
    }
    if (method === "mcp.close") return { closed: true };
    return {};
  };
  const extension = makeRemoteMcpToolsExtension({
    userId: 42,
    userName: "alice",
    projectHome: home,
    workspaceDir: "/home/alice/proj",
    machineId: "m1",
    serverKeyPrefix: "sess",
    rpc,
    agentForUser: () => agent,
  });
  return { pi, extension, tools, handlers, rpcCalls };
}

async function setup(config) {
  const home = projectHomeWith(config);
  const h = harness({ home });
  await h.extension.factory(h.pi);
  return { home, ...h };
}

test("only project stdio servers declaring plane=workspace are hosted on the agent", async () => {
  const { home, tools } = await setup({
    mcpServers: {
      relay: {
        command: "node",
        args: [".pi/mcp/cli.js"],
        piWeb: { plane: "workspace", risk: "read" },
      },
      hostish: {
        command: "node",
        args: [".pi/mcp/host.js"],
        piWeb: { plane: "host" },
      },
      remoteHttp: { url: "https://mcp.example/mcp" },
      off: { command: "node", piWeb: { plane: "workspace" }, disabled: true },
    },
  });
  try {
    assert.deepEqual([...tools.keys()].sort(), ["mcp_relay_echo", "mcp_relay_picture"]);
    assert.equal(isRelayWorkspaceServer({ command: "node", piWeb: { plane: "workspace" } }), true);
    assert.equal(isRelayWorkspaceServer({ command: "node", piWeb: { plane: "host" } }), false);
    assert.equal(isRelayWorkspaceServer({ url: "https://x", piWeb: { plane: "workspace" } }), false);
    assert.equal(relayMcpToolName("my-server", "my.tool"), "mcp_my_server_my_tool");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tool calls go over mcp.callTool with workspace base and amedac _meta", async () => {
  const { home, tools, rpcCalls } = await setup({
    mcpServers: {
      relay: {
        command: "node",
        args: [".pi/mcp/cli.js"],
        env: { FOO: "bar" },
        requestTimeoutMs: 120_000,
        piWeb: { plane: "workspace" },
      },
    },
  });
  try {
    const tool = tools.get("mcp_relay_echo");
    assert.ok(tool);
    const result = await tool.execute(
      "call-1",
      { text: "hi" },
      undefined,
      undefined,
      { cwd: "/server/home", sessionManager: { getHeader: () => ({ id: "session-77" }) } },
    );
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: "echo:hi" }]);

    const call = rpcCalls.find((c) => c.method === "mcp.callTool");
    assert.deepEqual(call.opts, { userId: 42, machineId: "m1", timeoutMs: 135_000 });
    assert.equal(call.params.serverKey, "sess:relay");
    assert.equal(call.params.command, "node");
    assert.deepEqual(call.params.args, [".pi/mcp/cli.js"]);
    assert.deepEqual(call.params.env, { FOO: "bar" });
    assert.equal(call.params.base, "/home/alice/proj");
    assert.equal(call.params.name, "echo");
    assert.deepEqual(call.params.arguments, { text: "hi" });
    assert.deepEqual(call.params._meta, {
      "amedac/session_id": "session-77",
      "amedac/user_id": 42,
      "amedac/user_name": "alice",
    });
    assert.equal(call.params.timeoutMs, 120_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("image content is returned to the model and errors are marked", async () => {
  const { home, tools } = await setup({
    mcpServers: {
      relay: { command: "node", args: [".pi/mcp/cli.js"], piWeb: { plane: "workspace" } },
    },
  });
  try {
    const image = await tools
      .get("mcp_relay_picture")
      .execute("call-1", {}, undefined, undefined, { sessionManager: { getHeader: () => null } });
    assert.deepEqual(image.content, [{ type: "image", data: "aW1n", mimeType: "image/png" }]);

    const failing = makeRemoteMcpToolsExtension({
      userId: 1,
      userName: "u",
      projectHome: home,
      serverKeyPrefix: "sess",
      rpc: async (method, params) => {
        if (method === "mcp.listTools") return { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
        if (method === "mcp.callTool") return { content: [{ type: "text", text: "boom" }], isError: true };
        return {};
      },
      agentForUser: () => AGENT,
    });
    const tools2 = new Map();
    await failedFactory(failing, tools2);
    const result = await tools2.get("mcp_relay_echo").execute("call-1", {}, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "boom" }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function failedFactory(extension, tools) {
  await extension.factory({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: () => {},
  });
}

test("session-start guard rejects adapter-eager workspace MCP entries", () => {
  const safeHome = projectHomeWith({
    mcpServers: {
      relay: {
        command: "node",
        lifecycle: "lazy",
        directTools: false,
        piWeb: { plane: "workspace" },
      },
    },
  });
  const unsafeHome = projectHomeWith({
    mcpServers: {
      relay: {
        command: "node",
        lifecycle: "keep-alive",
        directTools: true,
        piWeb: { plane: "workspace" },
      },
    },
  });
  try {
    assert.doesNotThrow(() => assertRelayWorkspaceMcpSafe(safeHome));
    assert.throws(() => assertRelayWorkspaceMcpSafe(unsafeHome), /lifecycle|directTools/);
  } finally {
    rmSync(safeHome, { recursive: true, force: true });
    rmSync(unsafeHome, { recursive: true, force: true });
  }
});

test("old agents and missing feature do not register relay MCP tools", async () => {
  const home = projectHomeWith({
    mcpServers: { relay: { command: "node", piWeb: { plane: "workspace" } } },
  });
  try {
    const tools = new Map();
    const extension = makeRemoteMcpToolsExtension({
      userId: 1,
      userName: "u",
      projectHome: home,
      rpc: async () => {
        throw new Error("must not call relay");
      },
      agentForUser: () => ({ info: { agentVersion: "0.7.0", features: [] } }),
    });
    await extension.factory({
      registerTool: (tool) => tools.set(tool.name, tool),
      on: () => {},
    });
    assert.equal(tools.size, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("session shutdown closes every hosted server", async () => {
  const { home, handlers, rpcCalls } = await setup({
    mcpServers: {
      relay: { command: "node", piWeb: { plane: "workspace" } },
    },
  });
  try {
    const shutdown = handlers.get("session_shutdown");
    assert.ok(shutdown);
    await shutdown();
    assert.ok(rpcCalls.some((c) => c.method === "mcp.close" && c.params.serverKey === "sess:relay"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
