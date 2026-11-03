import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "user-models-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DATA_DIR = join(root, "data");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      shared: { baseUrl: "http://gw/v1", api: "openai-completions", apiKey: "global-key", models: [{ id: "m1" }] }, // secret-scan:allow (test fixture) // secret-scan:allow (test fixture)
      globalOnly: { baseUrl: "http://g/v1", apiKey: "global-key", models: [{ id: "g1" }] }, // secret-scan:allow (test fixture)
    },
  }),
);
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ shared: { type: "api_key", key: "global-key" } }));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearUserModelConfig,
  effectiveAuthConfig,
  effectiveModelsConfig,
  ensureUserModelRuntime,
  hasUserModelOverride,
  readUserModels,
  userAuthPath,
  userModelsPath,
  credentialAuthPath,
  writeUserModels,
} = await jiti.import("./user-models.ts");

test("user config stores only providers that differ from global", () => {
  writeUserModels(1, {
    providers: {
      // 未改动 → 省略
      shared: { baseUrl: "http://gw/v1", api: "openai-completions", apiKey: "global-key", models: [{ id: "m1" }] }, // secret-scan:allow (test fixture)
      // 新增
      mine: { baseUrl: "http://mine/v1", api: "openai-completions", apiKey: "", models: [{ id: "x1" }] },
      // 改模型、空 apiKey 不落盘
      globalOnly: { baseUrl: "http://g/v1", models: [{ id: "g2" }], apiKey: "" },
    },
  });
  const stored = readUserModels(1);
  assert.deepEqual(Object.keys(stored.providers).sort(), ["globalOnly", "mine"]);
  assert.equal(stored.providers.mine.apiKey, undefined, "空 apiKey 不落盘");
  assert.equal(stored.providers.globalOnly.apiKey, undefined);
});

test("effective config merges global providers and keeps global apiKey when omitted", () => {
  const effective = effectiveModelsConfig(1);
  assert.equal(effective.providers.shared.apiKey, "global-key");
  assert.equal(effective.providers.globalOnly.models[0].id, "g2", "用户改写的模型生效");
  assert.equal(effective.providers.globalOnly.apiKey, "global-key", "用户没写的 apiKey 继承全局");
  assert.equal(effective.providers.mine.baseUrl, "http://mine/v1");
  assert.deepEqual(effectiveAuthConfig(1).shared, { type: "api_key", key: "global-key" });
});

test("runtime materializes merged files; clearing removes override", () => {
  const runtime = ensureUserModelRuntime(1);
  assert.ok(runtime);
  assert.equal(existsSync(runtime.modelsPath), true, "用户模型覆盖会生成合并 models");
  assert.equal(existsSync(runtime.authPath), true);
  const runtimeModels = JSON.parse(readFileSync(runtime.modelsPath, "utf8"));
  assert.equal(runtimeModels.providers.shared.apiKey, "global-key");
  assert.equal(hasUserModelOverride(1), true);
  clearUserModelConfig(1);
  assert.equal(hasUserModelOverride(1), false);
  assert.equal(existsSync(userModelsPath(1)), false);
  assert.equal(existsSync(userAuthPath(1)), false);
});

test("credential scope: admin writes global, user writes own auth", () => {
  assert.equal(credentialAuthPath(0, true), join(agentDir, "auth.json"));
  assert.equal(credentialAuthPath(7, false), userAuthPath(7));
});
