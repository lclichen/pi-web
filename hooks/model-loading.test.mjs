import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "useAgentSession.ts",
  await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
const loader = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "loadModels");
const schedule = nodes.find(
  (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_RETRY_DELAYS_MS",
);
const effect = nodes.find(
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "useEffect" &&
    node.arguments[1]?.getText(source) === "[loadModels, modelsRefreshKey]",
);
const retry = effect.arguments[0].body.statements.find(ts.isExpressionStatement).expression;
function script(text) {
  return new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
const loadScript = script(`(${loader.initializer.arguments[0].getText(source)})`);
const retryScript = script(retry.getText(source));

function setup(fetchImpl, overrides = {}) {
  const writes = [];
  const delays = [];
  const context = {
    Error,
    DOMException,
    controller: new AbortController(),
    newSessionCwd: "/project",
    newSessionProjectId: null,
    session: null,
    isNew: true,
    sessionIdRef: { current: null },
    thinkingLevelOverrideRef: { current: null },
    thinkingLevelPinsRef: { current: {} },
    defaultThinkingLevelRef: { current: null },
    asConcreteThinkingLevel: (value) => (!value || value === "auto" ? null : value),
    fetch: fetchImpl,
    MODELS_RETRY_DELAYS_MS: script(schedule.initializer.getText(source)).runInNewContext(),
    delay: async (ms) => {
      delays.push(ms);
    },
    ...overrides,
  };
  for (const name of [
    "ModelError",
    "ModelNames",
    "ModelScopeWarnings",
    "ModelThinkingLevels",
    "ModelThinkingLevelMaps",
    "ModelList",
    "NewSessionDefaultModel",
    "NewSessionDefaultThinkingLevel",
  ]) {
    context[`set${name}`] = (value) => writes.push([name, value]);
  }
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes, delays, run: () => retryScript.runInNewContext(context) };
}

test("model-load failures stay visible through bounded retries and clear on recovery", async () => {
  for (const [fetchImpl, expected] of [
    [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      "Failed to fetch",
    ],
    [async () => Response.json({ error: "Access denied" }, { status: 403 }), "Access denied"],
    [async () => new Response("Unavailable", { status: 503 }), "Failed to load models (HTTP 503)"],
    [
      async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Invalid JSON");
        },
      }),
      "Invalid JSON",
    ],
  ]) {
    const state = setup(fetchImpl);
    await state.run();
    assert.deepEqual(state.delays, [2_000, 5_000, 10_000]);
    assert.deepEqual(
      state.writes,
      Array.from({ length: 4 }, () => ["ModelError", expected]),
    );
  }

  let attempts = 0;
  const recovered = setup(async () => {
    if (++attempts === 1) throw new TypeError("Failed to fetch");
    return Response.json({
      models: { "custom:test": "Test" },
      modelList: [{ provider: "custom", id: "test", name: "Test" }],
      defaultModel: { provider: "custom", modelId: "test" },
      thinkingLevelPins: { "custom/test": "high" },
    });
  });
  await recovered.run();
  assert.equal(attempts, 2);
  assert.deepEqual(recovered.delays, [2_000]);
  assert.deepEqual(
    recovered.writes.filter(([name]) => name === "ModelError"),
    [
      ["ModelError", "Failed to fetch"],
      ["ModelError", null],
    ],
  );
  assert.ok(recovered.writes.some(([name, value]) => name === "ModelList" && value[0].id === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value.modelId === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));
});

test("existing sessions resolve models from their own cwd, never a stale project id", async () => {
  const urls = [];
  const state = setup(
    async (url) => {
      urls.push(String(url));
      return Response.json({ models: {}, modelList: [] });
    },
    {
      // 项目删除后的残留：已有会话绝不能继续按它解析（404「项目不存在」）。
      newSessionProjectId: "deleted-project",
      newSessionCwd: null,
      session: { id: "s1", cwd: "/projects/live", transient: false },
      isNew: false,
      sessionIdRef: { current: "s1" },
    },
  );
  await state.run();
  assert.deepEqual(urls, ["/api/models?cwd=%2Fprojects%2Flive"]);
});

test("only fresh drafts use projectId; a transient created session uses its own project binding", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return Response.json({ models: {}, modelList: [] });
  };

  const draft = setup(fetchImpl, { newSessionCwd: "/", newSessionProjectId: "project-a" });
  await draft.run();
  assert.deepEqual(urls, ["/api/models?projectId=project-a"]);

  urls.length = 0;
  // 刚创建、尚未水合：cwd 还是草稿占位 "/"，但草稿态 projectId 已清，
  // 只能依赖会话自身携带的项目绑定，不能回退到残留的旧 projectId。
  const transient = setup(fetchImpl, {
    newSessionProjectId: "stale-project",
    newSessionCwd: null,
    session: { id: "s2", cwd: "/", transient: true, projectId: "project-b" },
    isNew: false,
    sessionIdRef: { current: "s2" },
  });
  await transient.run();
  assert.deepEqual(urls, ["/api/models?projectId=project-b"]);

  urls.length = 0;
  // 水合完成（transient=false）后一律用真实 cwd。
  const hydrated = setup(fetchImpl, {
    newSessionProjectId: "stale-project",
    newSessionCwd: null,
    session: { id: "s2", cwd: "/projects/b", transient: false, projectId: "project-b" },
    isNew: false,
    sessionIdRef: { current: "s2" },
  });
  await hydrated.run();
  assert.deepEqual(urls, ["/api/models?cwd=%2Fprojects%2Fb"]);
});

test("cancelling model loads prevents state writes and further retries", async () => {
  for (const status of [200, 403]) {
    const reading = Promise.withResolvers();
    const state = setup(async (_url, { signal }) => ({
      ok: status === 200,
      status,
      json: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          reading.resolve();
        }),
    }));
    const completed = state.run();
    await reading.promise;
    state.context.controller.abort();
    await completed;
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.delays, []);
  }

  const late = setup(async (_url, { signal }) => ({
    ok: true,
    json: async () => {
      late.context.controller.abort();
      assert.equal(signal.aborted, true);
      return { models: {}, modelList: [] };
    },
  }));
  await late.run();
  assert.deepEqual(late.writes, []);

  let attempts = 0;
  const waiting = setup(async () => {
    attempts++;
    throw new TypeError("Failed to fetch");
  });
  waiting.context.delay = async () => waiting.context.controller.abort();
  await waiting.run();
  assert.equal(attempts, 1);
});
