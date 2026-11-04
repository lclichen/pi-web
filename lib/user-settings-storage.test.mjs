import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createUserSettingsManager } = await jiti.import("./user-settings-storage.ts");
const { userSettingsDiffPath } = await jiti.import("./user-config.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-user-settings-"));
  const previousData = process.env.PI_WEB_DATA_DIR;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_WEB_DATA_DIR = join(root, "data");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "global-provider",
      defaultModel: "global-model",
      defaultThinkingLevel: "low",
      defaultTools: ["read", "bash"],
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 1000 },
    }),
  );
  t.after(async () => {
    process.env.PI_WEB_DATA_DIR = previousData;
    process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, agentDir };
}

test("user settings start from the global layer", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  const manager = createUserSettingsManager(cwd, 7, { agentDir });

  assert.equal(manager.getDefaultProvider(), "global-provider");
  assert.equal(manager.getDefaultModel(), "global-model");
  assert.equal(manager.getDefaultThinkingLevel(), "low");
  assert.deepEqual(manager.getDefaultTools(), ["read", "bash"]);
  // Reading must not create .pi/settings.json (its existence triggers trust).
  assert.equal(existsSync(`${cwd}/.pi/settings.json`), false);
});

test("a user default reaches the user diff, never the global file", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  const manager = createUserSettingsManager(cwd, 7, { agentDir });

  manager.setDefaultModelAndProvider("user-provider", "user-model");
  manager.setDefaultThinkingLevel("high");
  await manager.flush();

  const global = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.equal(global.defaultModel, "global-model");
  assert.equal(global.defaultProvider, "global-provider");
  assert.equal(global.defaultThinkingLevel, "low");

  const diff = JSON.parse(await readFile(userSettingsDiffPath(7), "utf8"));
  assert.deepEqual(diff, {
    defaultProvider: "user-provider",
    defaultModel: "user-model",
    defaultThinkingLevel: "high",
  });

  const reopened = createUserSettingsManager(cwd, 7, { agentDir });
  assert.equal(reopened.getDefaultProvider(), "user-provider");
  assert.equal(reopened.getDefaultModel(), "user-model");
  assert.equal(reopened.getDefaultThinkingLevel(), "high");
  // Untouched global keys still read through.
  assert.equal(reopened.getTheme(), "dark");
});

test("project settings still win over the user layer", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  const manager = createUserSettingsManager(cwd, 7, { agentDir, projectTrusted: true });
  manager.setDefaultModelAndProvider("user-provider", "user-model");
  await manager.flush();

  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ defaultProvider: "project-provider", defaultModel: "project-model" }),
  );

  const reopened = createUserSettingsManager(cwd, 7, { agentDir, projectTrusted: true });
  assert.equal(reopened.getDefaultProvider(), "project-provider");
  assert.equal(reopened.getDefaultModel(), "project-model");
});
