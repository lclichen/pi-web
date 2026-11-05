import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { makePathGuardExtension } = await jiti.import(
  "../pi-config/agent/extensions/amedac-core/src/path-guard.ts",
);

const { createFauxProviderModule } = await (async () => {
  const mod = await import("@earendil-works/pi-ai/providers/faux");
  return { createFauxProviderModule: mod };
})();
const {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
} = await import("@earendil-works/pi-coding-agent");
const { Type } = await import("@earendil-works/pi-ai");

/** 真实 AgentSession（scripted faux provider）：验证护栏在真实工具循环里生效。 */
async function runScripted({ cwd, responses, extraExtensions = [] }) {
  const faux = createFauxProviderModule.fauxProvider({
    provider: "faux",
    models: [{ id: "scripted", contextWindow: 128000, maxTokens: 4096 }],
  });
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const agentDir = join(cwd, "..", "agent");
  mkdirSync(agentDir, { recursive: true });
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      extensionFactories: [makePathGuardExtension(), ...extraExtensions],
    },
  });
  const sessionManager = SessionManager.create(cwd, join(cwd, "..", "sessions"));
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model: faux.getModel(),
  });
  try {
    await session.prompt("do the thing");
    return session.messages;
  } finally {
    session.dispose();
    faux.unregister?.();
  }
}

function toolResults(messages) {
  return messages.filter((m) => m && m.role === "toolResult");
}

test("real agent loop: a denied write is blocked and the reason reaches the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "pg-e2e-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(cwd, "secret"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "path-policy.json"), JSON.stringify({
    version: 1,
    allowWrite: ["."],
    denyWrite: ["secret/**", ".env"],
    denyRead: [".env"],
    askOnOutsideWrite: true,
  }));

  const { fauxAssistantMessage, fauxToolCall } = createFauxProviderModule;
  const messages = await runScripted({
    cwd,
    responses: [
      fauxAssistantMessage(fauxToolCall("write", { path: "secret/leak.txt", content: "pwned" })),
      fauxAssistantMessage("done"),
    ],
  });

  assert.equal(existsSync(join(cwd, "secret", "leak.txt")), false, "被拦截的写入不得落盘");
  const results = toolResults(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  const text = results[0].content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /denyWrite/);
  assert.match(text, /不要重复尝试/);
  assert.match(text, /leak\.txt|secret/, "错误信息要带上被拒路径，模型才能改道");
});

test("real agent loop: remote path space (/workspace) is mapped before the deny rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "pg-e2e-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "path-policy.scope.json"),
    JSON.stringify({ version: 1, mode: "sandbox", workspaceRoot: "/workspace" }),
  );
  writeFileSync(join(cwd, ".pi", "path-policy.json"), JSON.stringify({
    version: 1,
    allowWrite: ["."],
    denyWrite: ["secret/**"],
    denyRead: [],
    askOnOutsideWrite: false,
  }));

  const { fauxAssistantMessage, fauxToolCall } = createFauxProviderModule;
  const messages = await runScripted({
    cwd,
    responses: [
      fauxAssistantMessage(fauxToolCall("write", { path: "/workspace/secret/leak.txt", content: "pwned" })),
      fauxAssistantMessage("done"),
    ],
  });
  const results = toolResults(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.match(results[0].content.map((c) => c.text ?? "").join("\n"), /denyWrite/);
});

test("real agent loop: bash bypasses (bare relative names) are blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "pg-e2e-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  writeFileSync(join(cwd, ".pi", "path-policy.json"), JSON.stringify({
    version: 1,
    allowWrite: ["."],
    denyWrite: [".env", "secrets/**"],
    denyRead: [".env"],
    askOnOutsideWrite: false,
  }));

  const { fauxAssistantMessage, fauxToolCall } = createFauxProviderModule;
  const messages = await runScripted({
    cwd,
    responses: [
      fauxAssistantMessage(fauxToolCall("bash", { command: "rm .env" })),
      fauxAssistantMessage("done"),
    ],
  });

  assert.equal(existsSync(join(cwd, ".env")), true, "rm .env 必须被拦截");
  const results = toolResults(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.match(results[0].content.map((c) => c.text ?? "").join("\n"), /denyWrite/);
});

test("real agent loop: bg_run goes through the same guard as bash (manifest commandParams)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pg-e2e-"));
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  writeFileSync(
    join(cwd, ".pi", "path-policy.json"),
    JSON.stringify({
      version: 1,
      allowWrite: ["."],
      denyWrite: [".env"],
      denyRead: [".env"],
      askOnOutsideWrite: false,
    }),
  );

  // 模拟 amedac-core 的 bg_run 工具（工具护栏按 manifest 的 commandParams 拦截，
  // 不依赖 bg-shell 的实现细节）；execute 计数证明被拦后没有真正后台执行。
  let executed = 0;
  const bgRunStub = (pi) => {
    pi.registerTool(
      defineTool({
        name: "bg_run",
        label: "BG Run",
        description: "run a command in the background",
        parameters: Type.Object({ command: Type.String() }),
        execute: async () => {
          executed += 1;
          return { content: [{ type: "text", text: "spawned" }], details: {} };
        },
      }),
    );
  };

  const { fauxAssistantMessage, fauxToolCall } = createFauxProviderModule;
  const messages = await runScripted({
    cwd,
    extraExtensions: [bgRunStub],
    responses: [
      fauxAssistantMessage(fauxToolCall("bg_run", { command: "rm .env" })),
      fauxAssistantMessage("done"),
    ],
  });

  assert.equal(executed, 0, "被护栏拦截的 bg_run 不得真正执行");
  assert.equal(existsSync(join(cwd, ".env")), true);
  const results = toolResults(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.match(results[0].content.map((c) => c.text ?? "").join("\n"), /denyWrite/);
});
