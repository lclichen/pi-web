import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

/**
 * Quick workspace materialization: the template allowlist decides which MCP
 * servers are enabled in `.pi/mcp.json`; tool-level entries enable their owner
 * server (exact tool filtering happens later in quickToolSet); everything else
 * gets a disabled tombstone. The template snapshot carries both dimensions.
 */

const root = mkdtempSync(join(tmpdir(), "pi-web-quick-session-"));
process.env.PI_WEB_DATA_DIR = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(root, "mcp-quick.json"),
  JSON.stringify({
    mcpServers: {
      alpha: { command: "node", args: ["alpha.js"] },
      beta: { command: "node", args: ["beta.js"] },
      mcp_tool_1: { command: "node", args: ["nested.js"] },
    },
  }),
  "utf8",
);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ensureQuickSessionWorkspace, readQuickTemplateSnapshot } = await jiti.import("./quick-session.ts");

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

function readWorkspaceMcp(dir) {
  return JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8"));
}

test("tool-level entries enable their owner server; other servers are tombstoned", () => {
  const template = {
    id: "tool-level",
    name: "Tool level",
    systemPrompt: "x",
    mcpTools: ["alpha_now", "mcp_tool_1_now-time-info"],
  };
  const { dir, slug } = ensureQuickSessionWorkspace(7, template);
  const mcp = readWorkspaceMcp(dir);
  assert.deepEqual(mcp.mcpServers.alpha, { command: "node", args: ["alpha.js"] });
  assert.deepEqual(mcp.mcpServers.mcp_tool_1, { command: "node", args: ["nested.js"] });
  assert.deepEqual(mcp.mcpServers.beta, { disabled: true });
  assert.equal(mcp.settings.disableProxyTool, true);

  const snapshot = readQuickTemplateSnapshot(dir);
  assert.deepEqual(snapshot.mcpTools, ["alpha_now", "mcp_tool_1_now-time-info"]);
  assert.deepEqual(snapshot.mcpServers, []);
  assert.equal(slug, `tool-level-${snapshot.hash}`);
});

test("whole-server grants enable every tool of that server and tombstone the rest", () => {
  const template = { id: "whole", name: "Whole", systemPrompt: "x", mcpServers: ["beta"] };
  const { dir } = ensureQuickSessionWorkspace(7, template);
  const mcp = readWorkspaceMcp(dir);
  assert.deepEqual(mcp.mcpServers.beta, { command: "node", args: ["beta.js"] });
  assert.deepEqual(mcp.mcpServers.alpha, { disabled: true });
  assert.deepEqual(mcp.mcpServers.mcp_tool_1, { disabled: true });
  assert.deepEqual(readQuickTemplateSnapshot(dir).mcpTools, []);
});

test("legacy mcpServers-only templates keep their historical workspace hash", () => {
  const template = { id: "legacy", name: "Legacy", systemPrompt: "x", mcpServers: ["alpha"] };
  const a = ensureQuickSessionWorkspace(7, template);
  const b = ensureQuickSessionWorkspace(7, { ...template, mcpTools: [] });
  assert.equal(a.slug, b.slug);
});
