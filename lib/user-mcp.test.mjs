import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ensureUserMcpRuntime } = await jiti.import("./user-mcp.ts");
const { userMcpConfigPath } = await jiti.import("./user-config.ts");

test("merges global and user MCP servers, with the user scope winning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-user-mcp-"));
  const previousData = process.env.PI_WEB_DATA_DIR;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const dataDir = join(root, "data");
  const agentDir = join(root, "agent");
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    process.env.PI_WEB_DATA_DIR = previousData;
    process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(agentDir, { recursive: true });
  await mkdir(join(dataDir, "user-config", "u7"), { recursive: true });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        global: { type: "http", url: "http://global.example/mcp" },
        shared: { type: "http", url: "http://global.example/shared" },
      },
    }),
  );
  await writeFile(
    userMcpConfigPath(7),
    JSON.stringify({
      mcpServers: {
        personal: { type: "http", url: "http://user.example/mcp" },
        shared: { type: "http", url: "http://user.example/shared" },
      },
    }),
  );

  const runtime = ensureUserMcpRuntime(7);
  assert.ok(runtime);
  const merged = JSON.parse(await readFile(runtime, "utf8"));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["global", "personal", "shared"]);
  assert.equal(merged.mcpServers.shared.url, "http://user.example/shared");
  assert.equal(merged.mcpServers.global.url, "http://global.example/mcp");

  // No personal file: the session keeps the plain global MCP path.
  assert.equal(ensureUserMcpRuntime(8), null);
});
