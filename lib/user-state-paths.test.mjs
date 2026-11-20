import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Batch 2: User JSON config sources live under state/users/u<id>. Legacy
 * user-config files remain readable for one release and are never written.
 */

const root = await mkdtemp(join(tmpdir(), "user-state-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  legacyUserMcpConfigPath,
  legacyUserPushPath,
  legacyUserSettingsDiffPath,
  userMcpConfigPath,
  userPiDir,
  userPushPath,
  userSettingsDiffPath,
} = await jiti.import("./user-config.ts");
const { readUserAuth, readUserModels, userAuthPath, userModelsPath, writeUserModels, clearUserModelConfig } =
  await jiti.import("./user-models.ts");
const { updateUserAgentSettings } = await jiti.import("./user-settings-storage.ts");
const { ensureUserMcpRuntime } = await jiti.import("./user-mcp.ts");

test.after(async () => {
  delete process.env.PI_WEB_DATA_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(root, { recursive: true, force: true });
});

test("user JSON config paths are under state/users/u<id>", () => {
  assert.equal(userPiDir(7), join(dataDir, "state", "users", "u7", "pi"));
  assert.equal(userSettingsDiffPath(7), join(dataDir, "state", "users", "u7", "pi", "settings.json"));
  assert.equal(userMcpConfigPath(7), join(dataDir, "state", "users", "u7", "pi", "mcp.json"));
  assert.equal(userPushPath(7), join(dataDir, "state", "users", "u7", "push.json"));
  assert.equal(userModelsPath(7), join(dataDir, "state", "users", "u7", "pi", "models.json"));
  assert.equal(legacyUserSettingsDiffPath(7), join(dataDir, "user-config", "u7", "settings.json"));
  assert.equal(legacyUserMcpConfigPath(7), join(dataDir, "user-config", "u7", "mcp.json"));
  assert.equal(legacyUserPushPath(7), join(dataDir, "user-config", "u7", "push.json"));
});

test("legacy settings diff is readable and the first write lands on the state path", async () => {
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(dataDir, "user-config", "u7"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ model: "global", theme: "light" }));
  await writeFile(legacyUserSettingsDiffPath(7), JSON.stringify({ model: "user-old" }));

  updateUserAgentSettings(7, { model: "user-new" });
  assert.deepEqual(JSON.parse(await readFile(userSettingsDiffPath(7), "utf8")), { model: "user-new" });
  assert.deepEqual(JSON.parse(await readFile(legacyUserSettingsDiffPath(7), "utf8")), { model: "user-old" });
});

test("legacy models/auth are readable; writes and clears target state", async () => {
  await mkdir(join(dataDir, "user-config", "u7"), { recursive: true });
  await writeFile(join(dataDir, "user-config", "u7", "models.json"), JSON.stringify({ version: 1, providers: { old: {} } }));
  await writeFile(join(dataDir, "user-config", "u7", "auth.json"), JSON.stringify({ old: { type: "api_key", key: "x" } }));

  assert.deepEqual(readUserModels(7), { version: 1, providers: { old: {} } });
  assert.deepEqual(readUserAuth(7), { old: { type: "api_key", key: "x" } });

  writeUserModels(7, { providers: { next: { model: "next" } } });
  assert.ok(existsSync(userModelsPath(7)));
  assert.ok(existsSync(userAuthPath(7)) === false);
  assert.ok(existsSync(join(dataDir, "user-config", "u7", "models.json")));

  clearUserModelConfig(7);
  assert.ok(!existsSync(userModelsPath(7)));
  assert.ok(!existsSync(userAuthPath(7)));
  assert.ok(!existsSync(join(dataDir, "user-config", "u7", "models.json")));
});

test("legacy user MCP config is read as fallback; runtime is still derived", async () => {
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(dataDir, "user-config", "u7"), { recursive: true });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { shared: { url: "http://global/shared" } } }),
  );
  await writeFile(
    legacyUserMcpConfigPath(7),
    JSON.stringify({ mcpServers: { personal: { url: "http://user/personal" } } }),
  );

  const runtime = ensureUserMcpRuntime(7);
  assert.ok(runtime);
  const merged = JSON.parse(await readFile(runtime, "utf8"));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["personal", "shared"]);
});
